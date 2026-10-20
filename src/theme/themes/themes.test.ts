import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_ID, THEMES, themeById } from "./index.ts";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Relative luminance per WCAG 2.1, for a 6-digit hex. */
function luminance(hex: string): number {
  const channel = (pair: string): number => {
    const value = Number.parseInt(pair, 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const h = hex.slice(1);
  return (
    0.2126 * channel(h.slice(0, 2)) +
    0.7152 * channel(h.slice(2, 4)) +
    0.0722 * channel(h.slice(4, 6))
  );
}

/** WCAG contrast ratio between two 6-digit hex colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("theme registry", () => {
  it("ships the five accents", () => {
    const ids = THEMES.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining(["steel", "indigo", "blue", "teal", "graphite"])
    );
  });

  it("has unique ids and human labels", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const theme of THEMES) {
      expect(theme.label.length).toBeGreaterThan(0);
    }
  });

  it("defaults to steel", () => {
    expect(DEFAULT_THEME_ID).toBe("steel");
  });

  it("resolves a known id and falls back to the default for unknown ids", () => {
    expect(themeById("teal").id).toBe("teal");
    expect(themeById("does-not-exist").id).toBe(DEFAULT_THEME_ID);
    expect(themeById(undefined).id).toBe(DEFAULT_THEME_ID);
  });

  it("every theme has a parseable hex accent (accentAlpha depends on it)", () => {
    for (const theme of THEMES) {
      expect(theme.colors.accent).toMatch(HEX_COLOR);
      expect(theme.colors.accentBright).toMatch(HEX_COLOR);
      expect(theme.colors.accentHover).toMatch(HEX_COLOR);
    }
  });

  it("graphite puts dark ink on its light accent fill", () => {
    const graphite = themeById("graphite");
    // The graphite accent is near-white; light onAccent text would wash out.
    // The dark ink is the chrome plane itself, so it moves with the chrome.
    expect(graphite.colors.onAccent).toBe(graphite.colors.chromeWindow);
  });
});

/**
 * The BisBig chrome (ADR-0023) is one flat cool plane: the window and the
 * content column are the *same* fill, and the rails sit one small step darker.
 * The old warm chrome told regions apart with three different greys plus a
 * titlebar gradient; asserting the identity here is what keeps a later
 * "just a shade lighter for the content" tweak from quietly reintroducing it.
 */
describe("the chrome is one flat cool plane", () => {
  it("makes the window and the content column the same fill", () => {
    for (const theme of THEMES) {
      expect(theme.colors.chromeContent).toBe(theme.colors.chromeWindow);
    }
  });

  it("gives the three rails one shared fill, a step off the plane", () => {
    for (const theme of THEMES) {
      expect(theme.colors.chromeSidebar).toBe(theme.colors.chromeInspector);
      expect(theme.colors.chromeRail).toBe(theme.colors.chromeSidebar);
      expect(theme.colors.chromeSidebar).not.toBe(theme.colors.chromeWindow);
    }
  });

  it("keeps every stop of the ink ramp a distinct value", () => {
    // Two stops at the same hex are two states that render identically — the
    // JumpRail's viewed and unseen dots are the case that caught this.
    const { colors } = themeById(DEFAULT_THEME_ID);
    const ramp = [
      colors.inkBright,
      colors.inkPrimary,
      colors.inkSecondary,
      colors.inkMuted,
      colors.inkDim,
      colors.inkFaint,
    ];
    expect(new Set(ramp).size).toBe(ramp.length);
  });

  /**
   * FEATURES.md promises AA. On this plane the ramp only affords two text
   * stops below `inkSecondary`, so which stop a surface may use is a rule
   * rather than a preference — and this is where it is written down.
   */
  it("keeps inkMuted at or above the 4.5:1 AA floor for text", () => {
    const { colors } = themeById(DEFAULT_THEME_ID);
    expect(
      contrast(colors.inkMuted, colors.chromeWindow)
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps inkDim above the 3:1 floor a non-text indicator owes", () => {
    const { colors } = themeById(DEFAULT_THEME_ID);
    expect(contrast(colors.inkDim, colors.chromeWindow)).toBeGreaterThanOrEqual(
      3
    );
  });
});

/**
 * The code palette is Kriyon's own: a teal keyword, a violet property and
 * warm functions on a near-black well, with booleans/`null` left at the
 * editor's ink. Pinning every value here means a later tweak is a deliberate
 * change to this test, not a silent drift.
 */
describe("the code palette is pinned", () => {
  const { colors } = themeById(DEFAULT_THEME_ID);

  it("pins the editor chrome", () => {
    expect({
      codeWell: colors.codeWell,
      editorActiveLine: colors.editorActiveLine,
      editorGutterActiveInk: colors.editorGutterActiveInk,
      editorGutterInk: colors.editorGutterInk,
      editorInk: colors.editorInk,
      editorSelection: colors.editorSelection,
    }).toEqual({
      codeWell: "#17181B",
      editorActiveLine: "#24262B",
      editorGutterActiveInk: "#E8EAEE",
      editorGutterInk: "#E8EAEE5C",
      editorInk: "#E8EAEE",
      editorSelection: "#3D4250A0",
    });
  });

  it("keeps constants at the editor's own ink rather than above it", () => {
    // `true`/`null` stay at the editor's ink — they read as values, not as a
    // fourth highlighted category. That only holds while the two stay equal; when
    // the base was the app's UI ink instead, constants rendered *brighter*
    // than the text around them and the claim in `base.ts` was false.
    expect(colors.syntaxConstant).toBe(colors.editorInk);
  });

  it("pins the token colours", () => {
    expect({
      syntaxAttribute: colors.syntaxAttribute,
      syntaxComment: colors.syntaxComment,
      syntaxConstant: colors.syntaxConstant,
      syntaxFunction: colors.syntaxFunction,
      syntaxKeyword: colors.syntaxKeyword,
      syntaxKeywordFlow: colors.syntaxKeywordFlow,
      syntaxNumber: colors.syntaxNumber,
      syntaxProperty: colors.syntaxProperty,
      syntaxPunctuation: colors.syntaxPunctuation,
      syntaxRegexp: colors.syntaxRegexp,
      syntaxString: colors.syntaxString,
      syntaxStringEscape: colors.syntaxStringEscape,
      syntaxTag: colors.syntaxTag,
      syntaxType: colors.syntaxType,
      syntaxVariable: colors.syntaxVariable,
    }).toEqual({
      syntaxAttribute: "#A69CF5",
      syntaxComment: "#E8EAEE94",
      syntaxConstant: "#E8EAEE",
      syntaxFunction: "#EBAD7E",
      syntaxKeyword: "#7CCBD6",
      // Control flow shares the keyword hue (see `base.ts`).
      syntaxKeywordFlow: "#7CCBD6",
      syntaxNumber: "#E6C487",
      syntaxProperty: "#A69CF5",
      syntaxPunctuation: "#D3D6DE",
      syntaxRegexp: "#D3D6DE",
      syntaxString: "#E08FCF",
      syntaxStringEscape: "#D3D6DE",
      syntaxTag: "#84BEF7",
      syntaxType: "#EBAD7E",
      syntaxVariable: "#D3D6DE",
    });
  });

  it("uses one code palette for every accent, so switching themes never recolours code", () => {
    for (const theme of THEMES) {
      expect(theme.colors.codeWell).toBe(colors.codeWell);
      expect(theme.colors.syntaxKeyword).toBe(colors.syntaxKeyword);
      expect(theme.colors.syntaxProperty).toBe(colors.syntaxProperty);
    }
  });
});
