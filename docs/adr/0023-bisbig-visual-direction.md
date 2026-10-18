# ADR 0023 — The BisBig visual direction: flat cool chrome, nav in the sidebar

**Status:** accepted · 2026-09-20

**Amended 2026-10-12:** the UI face is now **Geist** (SIL OFL 1.1), not Satoshi.
Satoshi's ITF Free Font License allows embedding it in the app but not sharing the
font files through a public repository, which going open source needs. Geist is
self-hosted at the same three weights (400 / 500 / 700), so the weight rule below
still holds.

**Extends:** [ADR-0007](0007-css-variable-theme-seam.md) (the theme seam this is
delivered through) · **Depends on:** [ADR-0019](0019-remove-the-structured-pane.md)
(why half the design canvas is deliberately not built)

## Context

Kriyon's chrome was drawn against the "UI Refresh" canvas: warm near-black
neutrals (`#1A1B1F` / `#1C1D22` / `#17181C`), vertical gradients on the title bar
and raised cards, a soft `raised` shadow, the system sans stack, and a 5/7/9/12
radius ramp. It reads well but it reads *generic* — the same warm graphite a
dozen desktop apps ship, and the gradients and shadows work against the hairline
language the rest of the app already uses.

A design pass on the BisBig product system re-cut the main screen and answered
two separate questions at once:

1. **What the surfaces should look like** — a cool blue-black plane where depth
   is a small lightness step and a hairline, never a gradient or a shadow.
2. **Where the app's navigation lives** — the canvas has no global title bar at
   all. The traffic lights sit in the sidebar's own top strip, and each column
   owns its 46px header.

The second question matters more than a repaint. Kriyon's title bar was carrying
the brand mark, the view switcher, search, Settings, About, and two panel
toggles — a horizontal strip of unrelated controls above three columns that each
already had a header's worth of their own. The canvas gives every one of those a
column to live in.

## Decision

**Adopt the canvas as the app's visual language, and its structure with it: the
global title bar goes away and navigation moves into the sidebar.** Visual and
layout only — no command, IPC call, store field, or Rust change comes with it.

### The look

- **One flat cool plane.** `chromeWindow` = `chromeContent` = `#0d1017`; the
  rails (`chromeSidebar` / `chromeInspector` / `chromeRail`) are `#0f131c`. Cards
  are `#10141d` with a `#1f2531` border. No gradient survives: `tokens.gradient`
  first published single-stop ramps so call sites could convert phase by phase,
  and once the last one had, the token and the four custom properties behind it
  were deleted — along with `accentGlow`, `shadow.accent`, `raisedBottom` and
  `chromeTitlebarTop`, which existed only to feed them. `shadow.raised` becomes
  `none`; `shadow.pop` / `toast` / `window` stay — a true overlay still earns a
  shadow.
- **A cooler ink ramp** (`#f2f5fa` → `#525d72`) and a GitHub-ish status set
  (`#3fb950` running/done, `#d29922` waiting with `#e3b341` ink, `#f0716f`
  error). Six stops, not the canvas's seven — see the AA consequence below.
- **Satoshi** for UI, self-hosted in `public/fonts/` beside the JetBrains faces;
  JetBrains Mono keeps everything machine-shaped (counts, branches, paths, kbd).
  Satoshi ships no 600 weight, so the app's weights are 400 / 500 / 700 — a 600
  would be synthesized and read muddy.
- **Tighter radii** (4 / 6 / 8 / 12, pill = `9999px`) and a **30 / 32 / 46** row
  rhythm: 30px nav and list rows, 32px key-value rows, 46px headers.
- **Steel** becomes the default theme — the canvas's `oklch(… 225)` steel-blue
  accent, converted to hex because `applyTheme` derives `--kr-accent-rgb` from a
  6-digit hex. Indigo, Cool blue, Teal and Graphite stay selectable; they now
  layer on the new chrome.
- **The syntax and editor palettes are untouched.** They are pinned by
  `themes.test.ts`, and code colour is not branding
  (`themes/types.ts`). The new chrome changes what surrounds a diff, never the
  diff's tokens.

### The structure

The 48px `TitleBar` is deleted. The shell becomes
`row[ sidebar | main column | Details ]`, full height, and every control it held
is rehomed to the column it belongs to: brand and view navigation to the sidebar,
search to the sidebar's own search box, Settings and About to the sidebar footer,
the terminal toggle to the main tab row, the inspector toggle to the Details
header. `Focus` — which *is* "hide the chrome" — becomes an icon button in the
sidebar's top strip rather than a peer of the destinations.

Two consequences follow, and they are the whole risk of the change:

- **The sidebar has to outlive the view.** It hosts navigation now, so it must
  be visible in Command centre, Prompts and Settings too. `SidebarPanel` lifts
  out of `SessionBody` to `Shell` level; `SessionBody` keeps the center column
  and the Details rail and stays mounted-and-display-toggled exactly as before.
  The center column's tree position does not change in either mode — a remount
  disposes every live xterm, which is the one thing this restyle may not do.
- **The 96px traffic-light clearance moves.** It was the title bar's left
  padding. It becomes the sidebar's top strip (always), the `FocusRail`'s 46px
  spacer, and the main header's left padding *when the sidebar is collapsed*.
  `trafficLightPosition` drops from `y: 25` to `y: 23` for the 46px strip — the
  one file outside `src/` this work touches (`src-tauri/tauri.conf.json`,
  configuration, no Rust).

### Style recipes, not a component library

The restyle converges ~150 ad-hoc style objects onto one module of pure
`CSSProperties` builders, `src/theme/recipes.ts` (`sectionLabel`, `row30`,
`kvRow`, `iconButton`, `button`, `chip`, `kbd`, `pill`, `card`, `inputBox`,
`statTile`). Recipes, not components: the seam stays "module-level style object
referencing `var(--kr-*)`" (ADR-0007), so nothing has to become a render-time
factory and no ThemeProvider appears. A shared `<Button>` would have been the
other answer; it would also have meant rewriting every call site's props, for a
restyle that is supposed to be a diff of values.

## What was deliberately not taken

The canvas was drawn against an imagined app, and the majority of its screen is
things Kriyon does not have. Taking the look does not mean building them:

- **The structured transcript** — message cards, tool-call rows, the inline
  diff, the `Structured | Raw` toggle, the inline `Allow` / `Deny` approval row.
  ADR-0019 removed that pane on purpose; the terminal is the source of truth and
  re-drawing the conversation is exactly the thing that ADR says to read as a
  request to reopen it.
- **Accounts and workspaces** — the workspace switcher chevrons on the brand
  block, the avatar/name/email footer. Kriyon has no accounts.
- **Issue tracking** — the `KRI-12` chip in the breadcrumb.
- **Inbox / Projects / History as destinations** and `Files` / `Terminal` as
  header tabs. The nav rows map to the views that exist (Sessions, Command
  centre, Prompts); "All files" stays a tab inside the Changes tree and the
  terminal stays a dock.
- **Composer permission-mode and effort chips**, and the Details rail's `Model`,
  `Weekly limit` and `$ cost` rows. The rule applied throughout: a row renders
  only if the value is already in a frontend store today. Anything else is
  dropped, not stubbed — a tile showing a plausible number Kriyon does not know
  is worse than no tile.

## Consequences

- **The window's whole top band is drag surface again, in three pieces.**
  `data-tauri-drag-region` has to be on the sidebar top strip, the main header,
  the Details header, *and* the headers of Command / Prompts / Settings —
  there is no longer one bar that covers the band. A view whose header forgets
  it is a view the user cannot drag the window from.
- **Tab labels change**: `Files & Changes | Raw` becomes `Changes | Session`.
  The `transcriptView` values (`changes` / `raw`) and every testid are
  unchanged; the visible and accessible names move together, because a control
  whose accessible name contradicts its label is worse than either name alone.
- **On this plane the ramp affords exactly one text stop below
  `inkSecondary`.** Measured against `#0d1017`: `inkMuted` is 5.01:1 and passes
  AA; `inkDim` is 3.34:1 and does not (it clears only the 3:1 a *non-text*
  indicator owes); `inkFaint` is 2.87:1 and clears nothing. That is a property
  of the palette, not something a nudged hex can fix — raising `inkDim` to 4.5
  would make it indistinguishable from `inkMuted`, and the ramp would lose the
  step it exists for.

  So which stop a surface may use is a **rule**, and it is the rule FEATURES.md's
  AA promise rests on:

  | stop | may be used for |
  |---|---|
  | `inkMuted` and brighter | anything the user reads — counts, timestamps, paths, descriptions, labels |
  | `inkDim` | icons, glyphs, drag grips, gutters, separators — never text |
  | `inkFaint` | decoration only: chevrons, placeholders, kbd borders, a viewed dot |

  Two tests in `themes.test.ts` compute the ratios and pin the two floors, so
  a later palette tweak that breaks the promise fails the suite rather than
  shipping. The sweep that enforced this moved ~30 call sites off `inkDim`.

- **The canvas's seventh ink stop is gone.** It specified `#525d72` for both
  `inkFaint` and `inkGhost`, which would have rendered the JumpRail's viewed
  and unseen dots identically; `inkGhost` was briefly given a darker value
  instead, and then removed outright. A stop below `inkFaint` is one no
  surface in this app is allowed to use — that makes it a trap, not a token.
- **The palette reference page** (`docs/kriyon-palette.html`) is documented as a
  mirror of `darkChrome` and has to move with it, or it becomes a lie.
- **A light theme is still one palette file away**, and slightly closer than
  before: with the gradients flattened and `shadow.raised` gone, there are fewer
  dark-only assumptions baked outside the theme files.

## Considered and rejected

- **Keep the title bar, repaint it.** The cheapest diff, and it keeps a strip of
  unrelated controls above three columns that each need their own header anyway.
  The canvas's answer — every column owns its top 46px — is why the design reads
  calmer than a palette swap would explain.
- **Keep Indigo as the default and ship Steel as a fifth option.** The chrome is
  cool now; the warm indigo that was tuned against `#1A1B1F` reads as a
  leftover on `#0d1017`. Making Steel the default is what makes the direction
  legible on first launch. Persisted explicit ids keep working through
  `themeById`, so nobody's chosen accent changes under them.
- **Build a real component library while we're in here.** Every file is being
  touched anyway, so the temptation is real. It is also a second, much larger
  change hiding inside a restyle: new props, new tests, new failure modes, and a
  diff nobody can review as "did the colours move correctly". Recipes get the
  convergence without the rewrite (YAGNI).
