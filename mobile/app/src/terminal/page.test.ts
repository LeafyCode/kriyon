import { expect, test } from "@jest/globals";
import { SYMBOLS_FONT, SYMBOLS_RANGE, TERMINAL_FONT } from "./layout.ts";
import { TERMINAL_PAGE } from "./page.generated.ts";

/** An embedded font face: its family, its WOFF bytes, its characters. */
const FONT_FACE =
  /@font-face\{font-family:"([^"]+)";src:url\(data:font\/woff;base64,([A-Za-z0-9+/=]+)\) format\("woff"\);unicode-range:([^;]+);\}/;

test("the page carries a fallback font for the symbols Android's fonts lack", () => {
  // Seen on the Android emulator: Claude Code's "⏵⏵ auto mode on" drew
  // two empty boxes, as no font on the phone has U+23F5.
  // The font's own bytes are inside the page: it loads with no network.
  const face = TERMINAL_PAGE.match(FONT_FACE);
  expect(face?.[1]).toBe(SYMBOLS_FONT);
  expect(face?.[2].length).toBeGreaterThan(1000);
  expect(face?.[3]).toBe(SYMBOLS_RANGE);
});

test("the terminal's font falls back to the symbols font after the phone's own", () => {
  const families = TERMINAL_FONT.split(",").map((one) => one.trim());
  expect(families.at(-1)).toBe(`"${SYMBOLS_FONT}"`);
  expect(families.indexOf("monospace")).toBeLessThan(families.length - 1);
});
