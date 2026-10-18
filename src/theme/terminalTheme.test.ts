import { describe, expect, it } from "vitest";
import { terminalTheme } from "./terminalTheme.ts";
import { THEMES, themeById } from "./themes/index.ts";

describe("terminalTheme", () => {
  it("builds the xterm theme from the app theme's concrete colors", () => {
    const indigo = themeById("indigo");
    const xterm = terminalTheme(indigo);
    expect(xterm.background).toBe(indigo.colors.chromeContent);
    expect(xterm.foreground).toBe(indigo.colors.inkPrimary);
    expect(xterm.cursor).toBe(indigo.colors.accentBright);
  });

  it("tints the selection with the accent at a fixed alpha", () => {
    // indigo accent #5E6AD2 → rgba(94, 106, 210, …)
    expect(terminalTheme(themeById("indigo")).selectionBackground).toBe(
      "rgba(94, 106, 210, 0.3)"
    );
  });

  it("paints the terminal on the same flat plane as the column around it", () => {
    // The pane has no fill of its own — the xterm canvas *is* the background,
    // so a terminal that doesn't match `chromeContent` draws a visible box.
    const steel = themeById("steel");
    expect(terminalTheme(steel).background).toBe(steel.colors.chromeWindow);
  });

  it("never leaks CSS variables into canvas-land", () => {
    for (const theme of THEMES) {
      for (const value of Object.values(terminalTheme(theme))) {
        expect(value).not.toContain("var(");
      }
    }
  });
});
