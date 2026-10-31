import { describe, expect, it } from "vitest";
import { contrast } from "./contrast.ts";
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

  it("leaves the ANSI colours at xterm's defaults for the Steel family", () => {
    expect(terminalTheme(themeById("steel")).red).toBeUndefined();
  });

  it("paints a community theme's own ANSI palette", () => {
    const dracula = terminalTheme(themeById("dracula"));
    expect(dracula.red).toBe("#ff5555");
    expect(dracula.brightWhite).toBe("#ffffff");
  });

  it("gives a light theme dark terminal text on a light plane", () => {
    const light = themeById("steel-light");
    const xterm = terminalTheme(light);
    expect(xterm.background).toBe(light.colors.chromeWindow);
    expect(xterm.foreground).toBe(light.colors.inkPrimary);
  });

  it("keeps a light theme's white and bright white readable on its plane", () => {
    // xterm's default white is #e5e5e5, and Solarized's canonical bright
    // white *is* its background — both invisible on a light plane. Programs
    // that assume a dark terminal print in white, so it must still read.
    for (const theme of THEMES.filter((t) => t.appearance === "light")) {
      const xterm = terminalTheme(theme);
      for (const key of ["white", "brightWhite"] as const) {
        const ink = xterm[key];
        expect(ink, `${theme.id}.${key}`).toBeDefined();
        expect(
          contrast(ink ?? "", theme.colors.chromeWindow),
          `${theme.id}.${key}`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
