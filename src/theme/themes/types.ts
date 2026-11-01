/**
 * A theme is one complete, concrete palette. Every visual color in the app is
 * named here; `applyTheme` publishes each value as a `--kr-*` CSS custom
 * property and `tokens.ts` references those properties, so switching themes
 * restyles the whole app without any component re-rendering.
 *
 * To add a theme: copy a full theme such as `nord.ts` (a palette spec passed
 * to `defineTheme` in `define.ts`), change the values, and add it to the
 * registry in `index.ts`. The spec's type keeps you honest — a missing key
 * fails the type check. The Steel-family files instead layer an accent over
 * `darkChrome` in `base.ts`.
 */
export interface ThemeColors {
  /** The brand color: primary buttons, the logo mark, selection highlights. */
  accent: string;
  /** Lighter accent stop: tab underlines, the active-row bar, progress fills,
   *  the terminal cursor. */
  accentBright: string;
  /** Hover fill for an accent-filled control. Inline styles can't express
   *  `:hover`, so this publishes through the seam and `.kr-hover-accent` in
   *  `App.css` reads it — the one hover an accent button has. */
  accentHover: string;
  /** Accent-tinted text/links readable on the theme's plane. */
  accentInk: string;

  /* Git / diff semantics. */
  add: string;
  addSoft: string;

  blockWell: string;
  border: string;
  /** Faint fill behind keycap chips and inline shortcut hints. */
  chip: string;
  /** The center content column — one notch lighter than the window base. */
  chromeContent: string;
  chromeInspector: string;
  chromeOverlay: string;
  chromeRail: string;
  chromeSidebar: string;

  /* Flat opaque chrome fills for the window regions. */
  chromeWindow: string;
  codeWell: string;
  del: string;
  delSoft: string;
  diffAddInk: string;
  diffDelInk: string;

  /** Fill under the caret's row in the code editor — a solid fill one step
   *  up from the well, not a translucent wash. */
  editorActiveLine: string;
  /** Line-number ink for the code editor's active row
   *  (`editorLineNumber.activeForeground`). */
  editorGutterActiveInk: string;
  /** Line-number ink for the code editor's gutter
   *  (`editorLineNumber.foreground`). */
  editorGutterInk: string;
  /** Vertical indent-guide rules in the code editor. */
  editorIndentGuide: string;
  /** The indent-guide rule for the block the caret currently sits in. */
  editorIndentGuideActive: string;
  /** The code editor's own default text ink, which an unclaimed token falls
   *  back to. Deliberately NOT the app's UI ink: basing it on chrome ink left
   *  plain code a different grey from the editor's and made `syntaxConstant`
   *  read brighter than the text around it. */
  editorInk: string;
  /** Text-selection fill in the code editor (`editor.selectionBackground`). */
  editorSelection: string;

  /* Text ramp, strongest to faintest: brightest-first on a dark theme,
   * darkest-first on a light one. */
  inkBright: string;
  inkDim: string;
  inkFaint: string;
  inkMuted: string;
  inkPrimary: string;
  inkSecondary: string;
  /** Sunken fill for a control that takes input or shows a level: the sidebar
   *  search box, a progress track, a switch track. Darker than the plane, so
   *  it reads as a well rather than a card. */
  inputWell: string;
  lineBase: string;

  /* Hairlines. */
  lineSoft: string;
  lineStrong: string;
  /** The [Mascot]'s thought bubbles. They float beside the mascot on its
   *  tile rather than on its body, so unlike the rest of the mascot they
   *  follow the plane: near-white on a dark theme, grey on a light one. */
  mascotThought: string;
  /** The git-gutter "modified" marker — VSCode-family blue, sitting between
   *  `add` (green) and `del` (red). */
  mod: string;
  /** Text/icons sitting on an accent fill (e.g. the Send button label). */
  onAccent: string;
  /** Card fill — composer, popovers, completion, dialogs. */
  raisedTop: string;

  /** The one scrim behind every modal/overlay. */
  scrim: string;
  statusDone: string;
  statusDoneSoft: string;
  statusError: string;
  statusErrorSoft: string;
  statusErrorWash: string;
  statusIdle: string;
  statusIdleSoft: string;

  /* Session status. `soft` = tinted pill fill, `wash` = faint row wash. */
  statusRunning: string;
  statusRunningInk: string;
  statusRunningSoft: string;
  statusWaiting: string;
  /** Ink for a waiting label — a stop brighter than the dot, so amber text
   *  stays legible on the amber wash behind it. */
  statusWaitingInk: string;
  statusWaitingSoft: string;
  statusWaitingWash: string;

  /* Translucent surface stops layered over the chrome. */
  surface1: string;
  surface2: string;
  surface3: string;
  /** The selected pill's fill in a Segmented control / tab strip. */
  surfaceActive: string;
  surfaceHover: string;

  /* Syntax palette — the one source both highlighters read.
   *
   * Deliberately its own block rather than reusing the UI ramp above. Code
   * colour has to separate a dozen token kinds at a glance while staying
   * legible on `codeWell`; the UI palette exists to separate *chrome*, and
   * only ever offered a handful of hues, which is why highlighting used to
   * collapse a dozen distinct token kinds into five colours.
   *
   * Accent-independent on purpose: the Steel family shares it through
   * `darkChrome`, so switching the accent restyles the app without
   * recolouring code. Highlighting is not branding — a keyword changing hue
   * because the user picked a different accent would be noise. A full theme
   * (light, Dracula, Nord…) does bring its own, because there the code
   * colours are half of what the theme is. */
  syntaxAttribute: string;
  syntaxComment: string;
  /** Booleans, `null`, enum members — constants that are not numbers.
   *  Deliberately left at the editor's ink. */
  syntaxConstant: string;
  syntaxFunction: string;
  /** Declaration keywords (`const`, `function`, `import`, `pub`, `fn`). */
  syntaxKeyword: string;
  /** Control flow (`if`, `return`, `await`, `match`). Carries the same value
   *  as {@link syntaxKeyword}; the slot stays because both highlighters map
   *  the two scope families separately and a future theme may want them
   *  apart. */
  syntaxKeywordFlow: string;
  syntaxNumber: string;
  /** Object/record property names (`{ a: 1 }`, `foo.bar`) — given their own
   *  colour rather than folding into {@link syntaxVariable}, so a config or a
   *  data literal reads clearly. */
  syntaxProperty: string;
  /** Brackets, commas, semicolons — dimmer than operators so structure
   *  recedes and names carry the eye. */
  syntaxPunctuation: string;
  syntaxRegexp: string;
  syntaxString: string;
  /** `\n`, `${…}` and friends inside a string, so an interpolation is
   *  visible rather than melting into the surrounding literal. */
  syntaxStringEscape: string;
  syntaxTag: string;
  /** Types, classes, interfaces, namespaces. */
  syntaxType: string;
  /** Variables, properties, parameters — the most common token in any file,
   *  so this is the near-neutral one. */
  syntaxVariable: string;
}

/**
 * The sixteen ANSI colours a theme paints the terminal with. Named as xterm's
 * `ITheme` names them, so `terminalTheme` can spread it straight in.
 */
export interface TerminalPalette {
  black: string;
  blue: string;
  brightBlack: string;
  brightBlue: string;
  brightCyan: string;
  brightGreen: string;
  brightMagenta: string;
  brightRed: string;
  brightWhite: string;
  brightYellow: string;
  cyan: string;
  green: string;
  magenta: string;
  red: string;
  white: string;
  yellow: string;
}

export interface Theme {
  /** Whether the plane is light or dark. Drives the webview's
   *  `color-scheme`, the ink-side wash colour, and the code editor's mode. */
  appearance: "dark" | "light";
  colors: ThemeColors;
  /** Stable identifier, persisted in the layout. */
  id: string;
  /** Human label shown in the theme switcher. */
  label: string;
  /** The terminal's ANSI palette. Absent → xterm's defaults, which only
   *  suit a dark plane. */
  terminal?: TerminalPalette;
}
