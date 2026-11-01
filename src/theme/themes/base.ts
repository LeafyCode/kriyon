import {
  faintFill,
  inkWash,
  mascotThoughtFor,
  scrimFor,
  softFill,
} from "./define.ts";
import type { ThemeColors } from "./types.ts";

// The three status hues the soft fills and washes below are tinted from.
const GREEN = "#3fb950";
const AMBER = "#d29922";
const CORAL = "#f0716f";
// Hoisted so the mascot-bubble rule below can be handed it too.
const INK_MUTED = "#79839a";

/**
 * The shared dark chrome from the **BisBig direction** canvas (ADR-0023): one
 * flat cool blue-black plane, hairline borders, a long cool ink ramp, and the
 * GitHub-family status hues. Depth is a small lightness step plus a 1px line —
 * never a gradient, and (outside true overlays) never a shadow.
 *
 * Three fills carry the whole layout:
 *
 * - `#0d1017` — the plane. Window, content column, terminal background, diff
 *   well. The window and the content column are deliberately the *same* value;
 *   what separates them is the sidebar and the rail, not a lightness step in
 *   the middle of the screen.
 * - `#0f131c` — the rails (sidebar, Details, focus rail), one notch darker so
 *   the working column reads as the lit surface between them.
 * - `#10141d` — a card (composer, diff file, settings group, stat tile) with a
 *   `#1f2531` border. `#161b26` is the overlay/chip step above it.
 *
 * The five Steel-family themes differ only in the accent block they layer on
 * top. Full themes (Steel Light, Dracula, Nord…) don't use this at all — they
 * are written as a spec through `defineTheme` in `define.ts` (ADR-0051).
 */
export const darkChrome: Omit<
  ThemeColors,
  "accent" | "accentBright" | "accentHover" | "accentInk" | "onAccent"
> = {
  border: "#1f2531",

  // Cool, and longer at the dim end than the warm ramp it replaced: the canvas
  // leans on three separate low-contrast greys (secondary labels, mono counts,
  // decorative glyphs) that the old ramp collapsed into one.
  //
  // Where the ramp stops being usable, measured on `#0d1017`:
  //
  // - `inkMuted` 5.01:1 — **the floor for anything the user reads.** Every
  //   count, timestamp, path and description sits here or brighter.
  // - `inkDim` 3.34:1 — fails AA for text, clears the 3:1 a non-text
  //   indicator owes: icons, glyphs, drag grips, gutters, separators.
  // - `inkFaint` 2.87:1 — decoration only, exactly as the canvas uses it:
  //   chevrons, placeholders, kbd borders, a viewed dot.
  //
  // The canvas's seventh stop (`#525d72` again, for "ghost") is deliberately
  // absent: it duplicated `inkFaint`, and a stop below `inkFaint` is one no
  // surface in this app is allowed to use, which makes it a trap rather than
  // a token.
  inkBright: "#f2f5fa",
  inkPrimary: "#eceff5",
  inkSecondary: "#aab3c5",
  inkMuted: INK_MUTED,
  inkDim: "#5c677d",
  inkFaint: "#525d72",

  // Translucent stops over the plane. `surface3` is the active sidebar row's
  // 6% — the one step the canvas draws brighter than its own hover.
  surface1: inkWash("dark", 0.03),
  surface2: inkWash("dark", 0.04),
  surface3: inkWash("dark", 0.06),
  surfaceHover: inkWash("dark", 0.04),
  surfaceActive: inkWash("dark", 0.06),

  // Opaque hairlines, not white alphas: on a plane this dark an alpha line
  // disappears over a card and doubles over a rail.
  lineSoft: "#161b26",
  lineBase: "#1c212c",
  lineStrong: "#232937",

  chromeWindow: "#0d1017",
  chromeContent: "#0d1017",
  chromeSidebar: "#0f131c",
  chromeInspector: "#0f131c",
  chromeRail: "#0f131c",
  chromeOverlay: "#161b26",
  raisedTop: "#10141d",

  // GitHub's status family, which is what the canvas draws: one green for
  // running *and* done (a finished session is told apart by a quiet ✓ and
  // faint ink, not by a second green), amber for waiting, coral for error.
  statusRunning: "#3fb950",
  statusRunningInk: "#3fb950",
  statusRunningSoft: softFill("dark", GREEN),
  statusWaiting: "#d29922",
  // The waiting *dot* is `#d29922`; its label is a stop brighter so amber text
  // stays legible at 10.5px on the amber wash behind it.
  statusWaitingInk: "#e3b341",
  statusWaitingSoft: softFill("dark", AMBER),
  statusWaitingWash: faintFill("dark", AMBER),
  statusDone: "#3fb950",
  statusDoneSoft: softFill("dark", GREEN),
  statusIdle: "#525d72",
  statusIdleSoft: inkWash("dark", 0.05),
  statusError: "#f0716f",
  statusErrorSoft: softFill("dark", CORAL),
  statusErrorWash: faintFill("dark", CORAL),

  add: "#3fb950",
  del: "#f0716f",
  mod: "#58a6ff",
  addSoft: softFill("dark", GREEN),
  delSoft: softFill("dark", CORAL),
  // Solid, not a translucent wash: the syntax palette below is tuned for an
  // opaque near-black well, and a see-through black over a tinted surface
  // reads washed-out next to it.
  codeWell: "#17181B",
  blockWell: "#12161f",
  // The added line's ink is the green itself; the removed line's is lifted so
  // coral text stays readable on its own tint.
  diffAddInk: "#3fb950",
  diffDelInk: "#ff9a98",
  /** Sunken fill for an input, a progress track, a switch track. */
  inputWell: "#1a2030",

  // The code editor's chrome. The active line is a SOLID fill one step up
  // from the well, not a white wash, so the row reads as located rather than
  // tinted. Selection and gutter ink use 8-digit alpha hex, which CSS
  // understands directly.
  editorActiveLine: "#24262B",
  editorGutterActiveInk: "#E8EAEE",
  editorGutterInk: "#E8EAEE5C",
  editorIndentGuide: inkWash("dark", 0.07),
  editorIndentGuideActive: inkWash("dark", 0.16),
  // The base both highlighters fall back to, so plain code has one ink.
  editorInk: "#E8EAEE",
  editorSelection: "#3D4250A0",

  scrim: scrimFor("dark"),
  mascotThought: mascotThoughtFor("dark", INK_MUTED),
  chip: "#161b26",

  // Syntax palette — Kriyon's own: a teal keyword, a violet property, warm
  // functions and types, and booleans/`null` left at the editor's ink so they
  // read as values rather than a fourth highlighted category. `themes.test.ts`
  // pins every value, so a change is deliberate.
  //
  // Untouched by the BisBig repaint, and deliberately so: code colour is not
  // branding. The new chrome changes what *surrounds* a diff, never the diff.
  //
  // Flow keywords (`if`/`return`) share the keyword hue and stay upright:
  // italics through real code are noisy at our type size. Comments are italic
  // in both highlighters.
  //
  // Shared by both highlighters: shiki tokenises the read-only diff and file
  // views, CodeMirror tokenises the same file once it is open for editing.
  // One palette, so a slot's *value* can never drift between them. What the
  // palette cannot force is that both engines route a given token to the same
  // slot — that is a per-engine scope/tag map, pinned by the golden tests in
  // `highlighter.test.ts` and `CodeEditor.test.tsx`. One known residual gap:
  // shiki gives a `const` binding the property violet, and lezer has no tag
  // that separates a `const` binding from a function parameter (both are
  // `VariableDefinition`), so the editor leaves those on the variable ink
  // rather than colouring parameters violet too.
  syntaxComment: "#E8EAEE94",
  syntaxKeyword: "#7CCBD6",
  syntaxKeywordFlow: "#7CCBD6",
  syntaxString: "#E08FCF",
  syntaxStringEscape: "#D3D6DE",
  syntaxNumber: "#E6C487",
  // Booleans / `null` stay at the editor's ink on purpose — they read as
  // values, not as a fourth highlighted category.
  syntaxConstant: "#E8EAEE",
  syntaxFunction: "#EBAD7E",
  syntaxType: "#EBAD7E",
  syntaxVariable: "#D3D6DE",
  // Properties get a hue of their own — the same violet as an attribute, so
  // the keys of a JSON or config file stand out.
  syntaxProperty: "#A69CF5",
  syntaxPunctuation: "#D3D6DE",
  syntaxRegexp: "#D3D6DE",
  syntaxTag: "#84BEF7",
  syntaxAttribute: "#A69CF5",
};
