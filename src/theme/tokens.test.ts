import { describe, expect, it } from "vitest";
import { accentAlpha, tokens } from "./tokens.ts";

const LEADS_WITH_GEIST = /^'Geist',/;

describe("tokens", () => {
  it("references theme CSS variables instead of literal colors", () => {
    expect(tokens.color.accent).toBe("var(--kr-accent)");
    expect(tokens.color.ink.bright).toBe("var(--kr-ink-bright)");
    expect(tokens.color.chrome.sidebar).toBe("var(--kr-chrome-sidebar)");
    expect(tokens.color.status.running).toBe("var(--kr-status-running)");
  });

  it("keeps the top-level text aliases in sync with the ink ramp", () => {
    expect(tokens.color.text).toBe(tokens.color.ink.bright);
    expect(tokens.color.textMuted).toBe(tokens.color.ink.muted);
  });

  it("accentAlpha composes the accent RGB triplet at an arbitrary alpha", () => {
    expect(accentAlpha(0.5)).toBe("rgba(var(--kr-accent-rgb), 0.5)");
  });

  it("resolves motion values through the --kr-motion-* seam", () => {
    expect(tokens.motion.panel).toBe("var(--kr-motion-panel)");
    expect(tokens.motion.disclose).toBe("var(--kr-motion-disclose)");
    expect(tokens.motion.hover).toBe("var(--kr-motion-hover)");
  });
});

/**
 * The non-color half of the BisBig direction (ADR-0023). These are pinned
 * because they are the values every recipe and every style object is written
 * against: a radius ramp that drifts back up, or a `raised` shadow that comes
 * back, un-flattens the whole app from one file.
 */
describe("the BisBig non-color tokens", () => {
  it("leads the sans stack with self-hosted Geist", () => {
    expect(tokens.font.sans).toMatch(LEADS_WITH_GEIST);
  });

  it("keeps JetBrains Mono for anything machine-shaped", () => {
    expect(tokens.font.mono).toContain("JetBrainsMono Nerd Font");
  });

  it("uses the tight 4/6/8/12 radius ramp with a true pill", () => {
    expect(tokens.radius).toEqual({
      sm: "4px",
      md: "6px",
      lg: "8px",
      xl: "12px",
      pill: "9999px",
    });
  });

  it("has no raised shadow — depth is a hairline and a lightness step", () => {
    expect(tokens.shadow.raised).toBe("none");
  });

  it("keeps a real shadow only for surfaces that genuinely float", () => {
    for (const key of ["window", "pop", "toast"] as const) {
      expect(tokens.shadow[key]).not.toBe("none");
    }
  });
});
