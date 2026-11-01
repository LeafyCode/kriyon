import { describe, expect, it } from "vitest";
import { applyTheme, cssVarName, MOTION } from "./applyTheme.ts";
import { themeById } from "./themes/index.ts";

describe("cssVarName", () => {
  it("maps camelCase color keys to --kr-kebab-case custom properties", () => {
    expect(cssVarName("accent")).toBe("--kr-accent");
    expect(cssVarName("inkBright")).toBe("--kr-ink-bright");
    expect(cssVarName("statusRunningSoft")).toBe("--kr-status-running-soft");
  });
});

describe("applyTheme", () => {
  /**
   * The chrome is flat (ADR-0023), so `applyTheme` publishes no gradient and
   * no accent glow at all — the three `--kr-gradient-*` properties and
   * `--kr-shadow-accent` are gone rather than flattened, along with the theme
   * keys that only existed to feed them.
   */
  it("publishes no gradient or glow properties", () => {
    applyTheme(themeById("steel"));
    const root = document.documentElement.style;
    for (const name of [
      "--kr-gradient-accent",
      "--kr-gradient-titlebar",
      "--kr-gradient-raised",
      "--kr-shadow-accent",
    ]) {
      expect(root.getPropertyValue(name)).toBe("");
    }
  });

  it("writes every theme color as a custom property on the root element", () => {
    const indigo = themeById("indigo");
    applyTheme(indigo);
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--kr-accent")).toBe(indigo.colors.accent);
    expect(root.getPropertyValue("--kr-ink-bright")).toBe(
      indigo.colors.inkBright
    );
    expect(root.getPropertyValue("--kr-chrome-sidebar")).toBe(
      indigo.colors.chromeSidebar
    );
  });

  it("derives the accent RGB triplet used by accentAlpha", () => {
    applyTheme(themeById("teal"));
    // teal accent #2BA391 → "43, 163, 145"
    expect(
      document.documentElement.style.getPropertyValue("--kr-accent-rgb")
    ).toBe("43, 163, 145");
  });

  it("publishes the theme-independent motion constants as --kr-motion-* properties", () => {
    applyTheme(themeById("indigo"));
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--kr-motion-panel")).toBe(MOTION.panel);
    expect(root.getPropertyValue("--kr-motion-disclose")).toBe(MOTION.disclose);
    expect(root.getPropertyValue("--kr-motion-hover")).toBe(MOTION.hover);
  });

  it("switching themes overwrites the previous theme's values", () => {
    applyTheme(themeById("indigo"));
    applyTheme(themeById("graphite"));
    const accent =
      document.documentElement.style.getPropertyValue("--kr-accent");
    expect(accent).toBe(themeById("graphite").colors.accent);
  });

  it("publishes the ink-side contrast colour for scrollbars and washes", () => {
    const root = document.documentElement.style;
    applyTheme(themeById("steel"));
    expect(root.getPropertyValue("--kr-contrast-rgb")).toBe("255, 255, 255");
    applyTheme(themeById("steel-light"));
    expect(root.getPropertyValue("--kr-contrast-rgb")).toBe("0, 0, 0");
  });

  it("tells the webview whether the theme is light or dark", () => {
    applyTheme(themeById("steel-light"));
    expect(document.documentElement.style.colorScheme).toBe("light");
    applyTheme(themeById("dracula"));
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});
