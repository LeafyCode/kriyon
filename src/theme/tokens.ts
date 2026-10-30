/**
 * The single source of truth for color, spacing, radii, and type. The look is
 * the BisBig direction (ADR-0023): one flat, opaque, cool blue-black plane —
 * regions are told apart by a one-step lightness shift and a 1px hairline,
 * never by a gradient, a blur, or an elevation. A single configurable accent
 * punctuates (primary action, brand tile, tab underline, selection); Geist
 * carries the UI and JetBrains Mono anything machine-shaped (paths, ids,
 * counts, code). Everything visual imports from here rather than hard-coding.
 *
 * Rows come in three heights — 30 (nav, list), 32 (key-value), 46 (header) —
 * and the shared shapes those heights imply live in `recipes.ts`.
 *
 * Every color resolves through a `--kr-*` custom property published by
 * `applyTheme` from the active theme in `themes/` — switching themes restyles
 * the app with no re-render. Add or adjust palettes there, not here.
 */

import type { DiffLine } from "../types.ts";
import { cssVarName } from "./applyTheme.ts";
import type { ThemeColors } from "./themes/index.ts";

/** A `var(--kr-*)` reference to the active theme's value for `key`. */
function themed(key: keyof ThemeColors): string {
  return `var(${cssVarName(key)})`;
}

/** The accent at an arbitrary alpha — for soft fills, tints, borders. */
export function accentAlpha(alpha: number): string {
  return `rgba(var(--kr-accent-rgb), ${alpha})`;
}

export const tokens = {
  color: {
    accent: themed("accent"),
    accentBright: themed("accentBright"),
    accentHover: themed("accentHover"),
    accentInk: themed("accentInk"),
    border: themed("border"),

    // Text ramp. `text`/`textMuted` are the two most common and stay top-level
    // for back-compat; `ink` is the full ramp from brightest to faintest.
    text: themed("inkBright"),
    textMuted: themed("inkMuted"),
    ink: {
      bright: themed("inkBright"),
      primary: themed("inkPrimary"),
      secondary: themed("inkSecondary"),
      muted: themed("inkMuted"),
      dim: themed("inkDim"),
      faint: themed("inkFaint"),
    },

    // Translucent surface stops (white over the dark stage).
    surface: {
      s1: themed("surface1"),
      s2: themed("surface2"),
      s3: themed("surface3"),
      hover: themed("surfaceHover"),
      active: themed("surfaceActive"),
    },
    // Hairlines.
    line: {
      soft: themed("lineSoft"),
      base: themed("lineBase"),
      strong: themed("lineStrong"),
    },
    // Flat, opaque chrome fills. `window` and `content` are the same plane;
    // the rails (`sidebar` / `inspector` / `rail`) sit one notch darker so the
    // working column reads as the lit surface between them. `overlay` is the
    // only elevated surface (modals / palette).
    chrome: {
      window: themed("chromeWindow"),
      content: themed("chromeContent"),
      sidebar: themed("chromeSidebar"),
      inspector: themed("chromeInspector"),
      rail: themed("chromeRail"),
      overlay: themed("chromeOverlay"),
    },

    // `soft` = the tinted pill fill, `wash` = the fainter whole-row wash,
    // `ink` = the text stop, which is not always the dot's own colour.
    status: {
      running: themed("statusRunning"),
      runningInk: themed("statusRunningInk"),
      runningSoft: themed("statusRunningSoft"),
      waiting: themed("statusWaiting"),
      waitingInk: themed("statusWaitingInk"),
      waitingSoft: themed("statusWaitingSoft"),
      waitingWash: themed("statusWaitingWash"),
      done: themed("statusDone"),
      doneSoft: themed("statusDoneSoft"),
      idle: themed("statusIdle"),
      idleSoft: themed("statusIdleSoft"),
      error: themed("statusError"),
      errorSoft: themed("statusErrorSoft"),
      errorWash: themed("statusErrorWash"),
    },
    // Git / diff semantics.
    add: themed("add"),
    del: themed("del"),
    mod: themed("mod"),
    addSoft: themed("addSoft"),
    delSoft: themed("delSoft"),
    /**
     * The syntax palette both highlighters read — shiki for the read-only
     * diff/file views, CodeMirror for the same file once it's open for
     * editing. Kept as one group precisely so those two can never drift:
     * before this they each carried their own hand-written colour map, and a
     * file changed colour depending on whether you were editing it.
     *
     * Theme-independent (it lives in `darkChrome`, not the accent block) —
     * see `themes/types.ts` for why highlighting deliberately doesn't follow
     * the accent.
     */
    syntax: {
      attribute: themed("syntaxAttribute"),
      comment: themed("syntaxComment"),
      constant: themed("syntaxConstant"),
      function: themed("syntaxFunction"),
      keyword: themed("syntaxKeyword"),
      keywordFlow: themed("syntaxKeywordFlow"),
      number: themed("syntaxNumber"),
      property: themed("syntaxProperty"),
      punctuation: themed("syntaxPunctuation"),
      regexp: themed("syntaxRegexp"),
      string: themed("syntaxString"),
      stringEscape: themed("syntaxStringEscape"),
      tag: themed("syntaxTag"),
      type: themed("syntaxType"),
      variable: themed("syntaxVariable"),
    },
    /** A card's fill — composer, diff file, settings group, dialog. */
    raised: themed("raisedTop"),
    // Dark wells for code / bash / diff blocks, and the prompt card fill.
    codeWell: themed("codeWell"),
    blockWell: themed("blockWell"),
    /** Sunken fill: search boxes, progress tracks, switch tracks. */
    inputWell: themed("inputWell"),
    diffAddInk: themed("diffAddInk"),
    diffDelInk: themed("diffDelInk"),
    // The code editor's chrome: active-line wash, gutter inks, indent
    // guides, and the selection fill.
    editorActiveLine: themed("editorActiveLine"),
    editorGutterActiveInk: themed("editorGutterActiveInk"),
    editorGutterInk: themed("editorGutterInk"),
    editorIndentGuide: themed("editorIndentGuide"),
    editorIndentGuideActive: themed("editorIndentGuideActive"),
    editorInk: themed("editorInk"),
    editorSelection: themed("editorSelection"),
    // macOS window controls — platform constants, not themed.
    traffic: { close: "#ff5f57", min: "#febc2e", max: "#28c840" },
    // The one scrim behind every modal/overlay.
    scrim: themed("scrim"),
    // Ink for text/icons sitting on the accent fill (primary buttons).
    onAccent: themed("onAccent"),
    // The faint white fill behind keycap chips and inline shortcut hints.
    chip: themed("chip"),
    // Composer inline highlight pills, one tint per token kind — indigo for a
    // leading `/command`, teal for an `@file` mention, amber for an
    // `@agent-…` mention, warm gray-orange for a leading `!` bash-mode char,
    // muted violet for a leading `#` memory-mode char. Semi-transparent so
    // they read as a tint over the composer's own surface rather than a
    // hard-edged chip.
    pill: {
      command: { bg: "rgba(129, 140, 248, 0.22)", fg: themed("inkBright") },
      mention: { bg: "rgba(45, 212, 191, 0.20)", fg: themed("inkBright") },
      agent: { bg: "rgba(251, 191, 36, 0.20)", fg: themed("inkBright") },
      bash: { bg: "rgba(168, 129, 96, 0.26)", fg: themed("inkBright") },
      memory: { bg: "rgba(148, 122, 219, 0.22)", fg: themed("inkBright") },
    },
  },
  font: {
    // Geist is shipped at 400 / 500 / 700 and no 600 — a `fontWeight: 600` here is
    // synthesized by the browser and reads muddy. Use 500 or 700.
    sans: "'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    mono: "'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  // sm = chips and kbd, md = rows/buttons/inputs, lg = cards, xl = dialogs.
  radius: {
    sm: "4px",
    md: "6px",
    lg: "8px",
    xl: "12px",
    pill: "9999px",
  },
  space: { xs: "4px", sm: "8px", md: "12px", lg: "16px", xl: "24px" },
  shadow: {
    // Depth comes from hairlines, not soft shadows. Only a surface that
    // genuinely floats above the app — the window itself, a modal, a toast —
    // casts one. An in-flow card does not: `raised` is `none`, kept as a token
    // so its call sites read "deliberately flat" rather than silently omitting
    // the property.
    window: "0 32px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.4)",
    pop: "0 8px 28px rgba(0,0,0,0.3)",
    raised: "none",
    toast: "0 6px 22px rgba(0,0,0,0.4)",
    /** Not depth: the accent's own light, on a small dot that stands for a
     *  signal on the move (the companion's starting screen). */
    glow: `0 0 8px ${accentAlpha(0.8)}`,
  },
  // No glass. The chrome is opaque and flat; only the modal/palette scrim keeps
  // a light blur so the dimmed app behind it reads as out of focus.
  blur: {
    window: "none",
    panel: "none",
    overlay: "blur(8px)",
  },
  // Shared motion vocabulary: one duration+easing pair per gesture family so
  // every collapsing/expanding surface moves the same way. Each value resolves
  // through a `--kr-motion-*` custom property published by applyTheme (from the
  // concrete MOTION map) — the same seam colors use (ADR-0007). Motion is
  // theme-independent, so App.css can reference the same vars without drifting.
  motion: {
    /** Panel and drawer slides (sidebars, composer, layout slides). */
    panel: "var(--kr-motion-panel)",
    /** Small inline disclosures (tree groups, history, chevrons). */
    disclose: "var(--kr-motion-disclose)",
    /** Hover / press state transitions. */
    hover: "var(--kr-motion-hover)",
  },
  /**
   * The [Mascot]s' own colours: illustration, not chrome, so they stay the
   * same in every theme. Named for scripts/mascots.py, which draws with
   * them. The body's colours come from the hue the user picks
   * (`layout.mascotHue`), set on the drawing as `--kr-m-*` variables.
   */
  mascot: {
    glint: "#ffffff",
    light: "#eef1ff",
    /** The thought bubbles beside a thinking mascot, and its "aha" spark. */
    thought: "#e9edf8",
    spark: "#ffd45c",
    mouth: "#7a1f3d",
    tongue: "#ff6f8e",
    hues: {
      cobalt: {
        shade0: "#3f4fc9",
        shade1: "#5a6cf0",
        shade2: "#7b8cff",
        shade3: "#a3b0ff",
        deep: "#35429f",
        halo: "#8fa2ff",
        ink: "#141a4a",
      },
      violet: {
        shade0: "#6a3fc9",
        shade1: "#8457ef",
        shade2: "#a07cff",
        shade3: "#c3a8ff",
        deep: "#56329f",
        halo: "#b39bff",
        ink: "#1e1240",
      },
      teal: {
        shade0: "#13827f",
        shade1: "#1fa3a0",
        shade2: "#3cc7c2",
        shade3: "#8fe6e1",
        deep: "#0f6a68",
        halo: "#6fd6d1",
        ink: "#072a2a",
      },
      amber: {
        shade0: "#c46a12",
        shade1: "#e08a24",
        shade2: "#f5a94a",
        shade3: "#ffd08a",
        deep: "#a35a0f",
        halo: "#ffc069",
        ink: "#2e1803",
      },
      rose: {
        shade0: "#c23a5b",
        shade1: "#e0567a",
        shade2: "#f27d9b",
        shade3: "#ffb3c6",
        deep: "#a32f4c",
        halo: "#ff9bb4",
        ink: "#2e0a14",
      },
      graphite: {
        shade0: "#4a5263",
        shade1: "#626b7e",
        shade2: "#7f899d",
        shade3: "#aab3c4",
        deep: "#3c4351",
        halo: "#9aa3b8",
        ink: "#12151c",
      },
    },
  },
  z: {
    base: 0,
    sticky: 10,
    popover: 30,
    overlayBackdrop: 40,
    overlay: 50,
    toast: 60,
  },
} as const;

/**
 * The `kind → color` mapping for a diff line: a tinted fill + ink for
 * added/removed, and just the muted ink for context (no background
 * override — callers that want an explicit "transparent" default supply it
 * themselves, since not every diff surface renders on the same base). This
 * is the single source for what was three near-identical copies across
 * `Diff.tsx`, `ReviewPanel.tsx`, and `DiffHunk.tsx`.
 */
export function diffLineColors(kind: DiffLine["kind"]): {
  background?: string;
  color: string;
} {
  if (kind === "added") {
    return { background: tokens.color.addSoft, color: tokens.color.diffAddInk };
  }
  if (kind === "removed") {
    return { background: tokens.color.delSoft, color: tokens.color.diffDelInk };
  }
  return { color: tokens.color.ink.muted };
}
