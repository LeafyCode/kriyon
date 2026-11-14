/**
 * The phone's look, light and dark, as the mobile design draws it
 * (design/mobile in the remote plan's folder). The accent is the desktop's
 * Steel and Steel Light; the rest is the phone's own palette. Screens take
 * colours only from here, through `useTheme`, never as literals.
 */
import { useColorScheme } from "react-native";
import { steel } from "../../../src/theme/themes/steel.ts";
import { steelLight } from "../../../src/theme/themes/steelLight.ts";

export interface Tokens {
  accent: string;
  /** Running, links, the accent's lighter use. */
  accentBright: string;
  /** Text in the accent's colour. */
  accentInk: string;
  accentLine: string;
  accentSoft: string;
  accentWash: string;
  amber: string;
  amberChip: string;
  amberFill: string;
  amberInk: string;
  amberLine: string;
  amberSoft: string;
  amberWell: string;
  amberWellLine: string;
  bg: string;
  blueChip: string;
  card: string;
  /** Decorative only: never text a person has to read. */
  dim: string;
  grabber: string;
  green: string;
  greenChip: string;
  greenInk: string;
  greenSoft: string;
  ink: string;
  ink1: string;
  ink2: string;
  knob: string;
  line: string;
  lineSoft: string;
  lineStrong: string;
  muted: string;
  /** Text on `accent`. */
  onAccent: string;
  /** Text on `amberFill`. */
  onAmber: string;
  overlay: string;
  rail: string;
  red: string;
  redLine: string;
  scrim: string;
  term: string;
}

export const dark: Tokens = {
  accent: steel.colors.accent,
  accentBright: steel.colors.accentBright,
  accentInk: steel.colors.accentInk,
  accentLine: "#1d6079",
  accentSoft: "#0e3442",
  accentWash: "#0b1e27",
  amber: "#d29922",
  amberChip: "#3a2c0c",
  amberFill: "#d29922",
  amberInk: "#e3b341",
  amberLine: "#71561a",
  amberSoft: "#2b2210",
  amberWell: "#12100a",
  amberWellLine: "#2e2510",
  bg: "#0a0d13",
  blueChip: "#0f3443",
  card: "#161b26",
  dim: "#5c677d",
  grabber: "#2c3342",
  green: "#3fb950",
  greenChip: "#123d20",
  greenInk: "#56d364",
  greenSoft: "#0f3a1e",
  ink: "#f5f7fb",
  ink1: "#e6eaf2",
  ink2: "#a7b0c2",
  knob: "#ffffff",
  line: "#2a3243",
  lineSoft: "#212836",
  lineStrong: "#353f53",
  muted: "#8a94a9",
  onAccent: steel.colors.onAccent,
  onAmber: "#1a1305",
  overlay: "#1f2532",
  rail: "#0e121a",
  red: "#f0716f",
  redLine: "#3a2328",
  scrim: "#06080c",
  term: "#c9d1de",
};

export const light: Tokens = {
  accent: steelLight.colors.accent,
  accentBright: "#0a8cb3",
  accentInk: "#006a8a",
  accentLine: "#94cbe0",
  accentSoft: "#d9eff7",
  accentWash: "#eef8fb",
  amber: "#b47d0e",
  amberChip: "#f7e3ad",
  amberFill: "#8a5f00",
  // Darker than the mockup's #8a5f00, for 4.5:1 on amberChip.
  amberInk: "#7a5400",
  amberLine: "#e0bb5c",
  amberSoft: "#fff3d3",
  amberWell: "#fffbf0",
  amberWellLine: "#f0e2bb",
  bg: "#eef1f5",
  blueChip: "#d6edf6",
  card: "#ffffff",
  dim: "#7d8494",
  grabber: "#d5d9e0",
  green: "#1f883d",
  greenChip: "#d3efdb",
  // Darker than the mockup's #1a7f37, for 4.5:1 on greenChip.
  greenInk: "#146c2e",
  greenSoft: "#dcf2e3",
  ink: "#0b1220",
  ink1: "#1a2233",
  ink2: "#2e3646",
  knob: "#ffffff",
  line: "#d5dbe4",
  lineSoft: "#e3e7ed",
  lineStrong: "#c2cad6",
  muted: "#525a69",
  onAccent: "#ffffff",
  onAmber: "#ffffff",
  overlay: "#e8ecf1",
  rail: "#e6eaf0",
  red: "#c2413f",
  redLine: "#f0c9c8",
  scrim: "#c9ced6",
  term: "#1f2328",
};

/** The fonts the design uses, as `expo-font` loads them (App.tsx). */
export const fonts = {
  bold: "Geist_700Bold",
  medium: "Geist_500Medium",
  mono: "JetBrainsMono_400Regular",
  monoMedium: "JetBrainsMono_500Medium",
  regular: "Geist_400Regular",
};

export type Mode = "dark" | "light";

/** The palette for `mode`. */
export function tokensFor(mode: Mode): Tokens {
  return mode === "light" ? light : dark;
}

/** The phone's own setting, light or dark (dark when it says neither). */
export function useMode(): Mode {
  return useColorScheme() === "light" ? "light" : "dark";
}

/** The palette for the phone's light or dark setting. */
export function useTheme(): Tokens {
  return tokensFor(useMode());
}
