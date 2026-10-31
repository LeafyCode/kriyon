import { hexAlpha } from "../hex.ts";
import type { ThemeColors } from "./types.ts";

/**
 * The few colours a full theme actually chooses. Everything else in
 * {@link ThemeColors} — soft fills, washes, the translucent surface stops,
 * gutter inks — is derived from these by {@link definePalette}, so each
 * community theme states its own palette once instead of hand-writing
 * seventy values that must stay in step.
 *
 * All values are 6-digit hex (`editor.selection` may carry an alpha byte):
 * the derivations compose rgba() from them.
 */
export interface PaletteSpec {
  accent: {
    /** Fills: Send, primary buttons, the brand tile. */
    fill: string;
    /** Tab underline, active-row bar, progress fill, terminal cursor. */
    bright: string;
    hover: string;
    /** Accent-tinted text on the plane. */
    ink: string;
    /** Text on the accent fill. */
    on: string;
  };
  appearance: "dark" | "light";

  editor: {
    activeLine: string;
    ink: string;
    selection: string;
  };
  /** Text ramp, brightest-to-faintest on a dark theme (darkest-to-faintest on
   *  a light one): bright, primary, secondary, muted, dim, faint. */
  ink: readonly [string, string, string, string, string, string];

  lines: {
    soft: string;
    base: string;
    strong: string;
  };

  planes: {
    /** Window and content column — the one plane. */
    plane: string;
    /** Sidebar, Details and focus rail: one step off the plane. */
    rail: string;
    /** Composer, diff file, settings group. */
    card: string;
    /** Popovers, palette, dialogs — and keycap chips. */
    overlay: string;
    /** Search box, progress and switch tracks. */
    input: string;
    /** Code and diff views. */
    code: string;
    /** Bash / tool-call blocks and the prompt card. */
    block: string;
  };

  status: {
    green: string;
    amber: string;
    /** Amber text — a stop legible on the amber wash. */
    amberInk: string;
    red: string;
    /** Red text — a stop legible on the red tint. */
    redInk: string;
    /** The git "modified" marker. */
    blue: string;
  };

  syntax: {
    attribute: string;
    comment: string;
    constant: string;
    escape: string;
    function: string;
    keyword: string;
    number: string;
    property: string;
    punctuation: string;
    regexp: string;
    string: string;
    tag: string;
    type: string;
    variable: string;
  };
}

/** Expand a {@link PaletteSpec} into every colour the app reads. */
export function definePalette(spec: PaletteSpec): ThemeColors {
  const { accent, editor, ink, lines, planes, status, syntax } = spec;
  const light = spec.appearance === "light";
  // Ink-side washes: white over a dark plane, black over a light one. A light
  // plane needs a touch more alpha for the same visible step.
  const wash = (alpha: number): string =>
    light
      ? `rgba(0, 0, 0, ${Math.round(alpha * 1.25 * 1000) / 1000})`
      : `rgba(255, 255, 255, ${alpha})`;
  const soft = (hex: string): string => hexAlpha(hex, light ? 0.14 : 0.12);
  const faint = (hex: string): string => hexAlpha(hex, light ? 0.1 : 0.08);
  const editorBase = editor.ink.slice(0, 7);

  return {
    accent: accent.fill,
    accentBright: accent.bright,
    accentHover: accent.hover,
    accentInk: accent.ink,
    onAccent: accent.on,

    inkBright: ink[0],
    inkPrimary: ink[1],
    inkSecondary: ink[2],
    inkMuted: ink[3],
    inkDim: ink[4],
    inkFaint: ink[5],

    surface1: wash(0.03),
    surface2: wash(0.04),
    surface3: wash(0.06),
    surfaceHover: wash(0.04),
    surfaceActive: wash(0.06),

    border: lines.base,
    lineSoft: lines.soft,
    lineBase: lines.base,
    lineStrong: lines.strong,

    chromeWindow: planes.plane,
    chromeContent: planes.plane,
    chromeSidebar: planes.rail,
    chromeInspector: planes.rail,
    chromeRail: planes.rail,
    chromeOverlay: planes.overlay,
    raisedTop: planes.card,
    chip: planes.overlay,
    inputWell: planes.input,
    codeWell: planes.code,
    blockWell: planes.block,

    statusRunning: status.green,
    statusRunningInk: status.green,
    statusRunningSoft: soft(status.green),
    statusWaiting: status.amber,
    statusWaitingInk: status.amberInk,
    statusWaitingSoft: soft(status.amber),
    statusWaitingWash: faint(status.amber),
    statusDone: status.green,
    statusDoneSoft: soft(status.green),
    statusIdle: ink[5],
    statusIdleSoft: wash(0.05),
    statusError: status.red,
    statusErrorSoft: soft(status.red),
    statusErrorWash: faint(status.red),

    add: status.green,
    del: status.red,
    mod: status.blue,
    addSoft: soft(status.green),
    delSoft: soft(status.red),
    diffAddInk: status.green,
    diffDelInk: status.redInk,

    editorActiveLine: editor.activeLine,
    editorGutterActiveInk: editorBase,
    editorGutterInk: `${editorBase}80`,
    editorIndentGuide: wash(0.07),
    editorIndentGuideActive: wash(0.16),
    editorInk: editor.ink,
    editorSelection: editor.selection,

    scrim: light ? "rgba(15, 20, 30, 0.32)" : "rgba(5, 7, 12, 0.6)",

    syntaxAttribute: syntax.attribute,
    syntaxComment: syntax.comment,
    syntaxConstant: syntax.constant,
    syntaxFunction: syntax.function,
    syntaxKeyword: syntax.keyword,
    syntaxKeywordFlow: syntax.keyword,
    syntaxNumber: syntax.number,
    syntaxProperty: syntax.property,
    syntaxPunctuation: syntax.punctuation,
    syntaxRegexp: syntax.regexp,
    syntaxString: syntax.string,
    syntaxStringEscape: syntax.escape,
    syntaxTag: syntax.tag,
    syntaxType: syntax.type,
    syntaxVariable: syntax.variable,
  };
}
