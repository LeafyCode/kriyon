import { expect, test } from "@jest/globals";
import { dark, light, type Tokens } from "./theme.ts";

/** WCAG's relative luminance of `hex` (#rrggbb). */
function luminance(hex: string): number {
  const channel = (at: number) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every text colour the screens put on each background. */
const TEXT_ON: [keyof Tokens, keyof Tokens][] = [
  ["ink", "bg"],
  ["ink1", "bg"],
  ["ink2", "bg"],
  ["muted", "bg"],
  ["ink", "card"],
  ["ink1", "card"],
  ["ink2", "card"],
  ["muted", "card"],
  ["ink2", "rail"],
  ["muted", "rail"],
  ["term", "bg"],
  ["accentInk", "bg"],
  ["accentInk", "card"],
  ["accentInk", "rail"],
  ["accentInk", "blueChip"],
  ["accentInk", "accentSoft"],
  ["ink1", "accentSoft"],
  ["onAccent", "accent"],
  ["amberInk", "amberChip"],
  ["amberInk", "amberSoft"],
  ["ink", "amberSoft"],
  ["ink1", "amberSoft"],
  ["ink2", "amberSoft"],
  ["muted", "amberSoft"],
  ["ink1", "amberWell"],
  ["onAmber", "amberFill"],
  ["greenInk", "greenChip"],
  ["greenInk", "greenSoft"],
  ["red", "card"],
  ["ink2", "overlay"],
  ["ink", "lineStrong"],
];

test.each([
  ["dark", dark],
  ["light", light],
])("every text in %s mode is readable: contrast of at least 4.5:1", (_, t) => {
  const low = TEXT_ON.map(([fg, bg]) => ({
    pair: `${fg} on ${bg}`,
    ratio: Math.round(contrast(t[fg], t[bg]) * 100) / 100,
  })).filter(({ ratio }) => ratio < 4.5);
  expect(low).toEqual([]);
});
