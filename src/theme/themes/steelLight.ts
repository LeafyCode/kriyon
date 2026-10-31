import { definePalette } from "./define.ts";
import type { Theme } from "./types.ts";

/**
 * The light side of the BisBig direction (ADR-0023), from BisBig's own light
 * tokens: a near-white plane, rails one notch darker, white cards, the
 * deepened status family (`#1f883d` / `#b47d0e` / `#c2413f`) and the Steel
 * accent at its fill stop. Code and terminal colours follow GitHub Light.
 */
export const steelLight: Theme = {
  id: "steel-light",
  label: "Steel Light",
  appearance: "light",
  colors: definePalette({
    appearance: "light",
    accent: {
      bright: "#0a8cb3",
      fill: "#007ea2",
      hover: "#006f90",
      ink: "#006a8a",
      on: "#ffffff",
    },
    editor: {
      activeLine: "#eaedf1",
      ink: "#1f2328",
      selection: "#9fd0e566",
    },
    ink: ["#0b1220", "#1a2233", "#2e3646", "#5a6170", "#7d8494", "#9aa0ae"],
    lines: {
      base: "#e3e6eb",
      soft: "#eceef2",
      strong: "#d5d9e0",
    },
    planes: {
      block: "#f2f3f6",
      card: "#ffffff",
      code: "#f6f7f9",
      input: "#eceef2",
      overlay: "#ffffff",
      plane: "#fbfbfc",
      rail: "#f4f5f7",
    },
    status: {
      amber: "#b47d0e",
      amberInk: "#8a5f00",
      blue: "#2a6fdb",
      green: "#1f883d",
      red: "#c2413f",
      redInk: "#b3302e",
    },
    syntax: {
      attribute: "#0550ae",
      comment: "#6e7781",
      constant: "#0550ae",
      escape: "#116329",
      function: "#8250df",
      keyword: "#cf222e",
      number: "#0550ae",
      property: "#0550ae",
      punctuation: "#1f2328",
      regexp: "#116329",
      string: "#0a3069",
      tag: "#116329",
      type: "#953800",
      variable: "#1f2328",
    },
  }),
  terminal: {
    black: "#24292f",
    blue: "#0969da",
    brightBlack: "#57606a",
    brightBlue: "#218bff",
    brightCyan: "#3192aa",
    brightGreen: "#1a7f37",
    brightMagenta: "#a475f9",
    brightRed: "#a40e26",
    brightWhite: "#8c959f",
    brightYellow: "#633c01",
    cyan: "#1b7c83",
    green: "#116329",
    magenta: "#8250df",
    red: "#cf222e",
    white: "#6e7781",
    yellow: "#4d2d00",
  },
};
