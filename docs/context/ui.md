# App shell and look

The window chrome, menus, themes and the WebKit guards that keep the UI responsive.

Part of the Kriyon glossary. The index and the naming rule are in [`CONTEXT.md`](../../CONTEXT.md).

- **Stray caret** — a collapsed DOM selection left sitting in non-editable content (a diff line, a
  transcript block, the sidebar) after an ordinary click. The user can't type there, but macOS
  WebKit rescans every character behind it on each rendering update to build autocorrect
  candidates, which froze the UI for as long as anything kept repainting. Cleared on pointer-up by
  `installStrayCaretGuard`. A range selection is never a stray caret — that one is the user
  copying. _Avoid_: dead selection, phantom cursor.
- **DOM weight** (`installDomWeightWatch`) — how many elements Kriyon's single document holds at
  once, across every mounted [Session] pane. The number that actually drives the [Stray caret]
  freeze: macOS WebKit's whole-document passes are quadratic in what they cover, so a heavy
  document stalls on a keystroke no matter how the caret got there. The [Warm pane] cap bounds
  pane *count*, which is a proxy — this is the thing itself, watched in dev builds and warned
  about once per crossing. _Avoid_: DOM size, node count.
- **Collapsible section** (`CollapsibleSection`) — the shared disclosure primitive (chevron,
  title, an always-visible `headerRight` slot) with its open state persisted in `layout`. Its
  body is always mounted and only display-toggled, so collapsing never destroys a subtree's
  state. Adapters: the Inspector's Changes section. _Avoid_: accordion, disclosure.
- **Mascot** (`Mascot`, `MASCOTS`, `layout.mascot`, `layout.mascotHue`) — the small glowing AI
  orb at the top of the [Structured view], picked in Settings: the Visor (default), the Gem, the Hex,
  or none, in a hue of the user's choosing (`tokens.mascot.hues`, drawn through `--kr-m-*`
  variables). Drawn as layered vector art by `scripts/mascots.py`, it just floats; it wears one of
  eight faces at a time (`data-face`), and every few seconds, and on a click, plays a random trick
  (`mascotMoves.ts`) with a face to match — a hop, a spin, a wink, a doze, a peek, each one's own
  (the Visor's scan, the Gem's sparkle, the Hex's facet flash). While Claude works it wears its
  thinking face, thought bubbles rising and little lights circling, and plays only thinking tricks
  (an "aha" spark, a ponder). Kriyon's own characters, not Claude Code's (no Anthropic marks).
- **Wordmark** — Kriyon's name in the sidebar's own 46px top strip, sharing the band the
  native traffic lights already force 96px of clearance for. That clearance is why the
  wordmark sits there for free, and it replaced the title bar's logo cluster when the title
  bar went away (ADR-0023). Identity only — it is not a switcher and opens nothing. The
  canvas's separate **brand block** below the strip (an accent tile carrying the logo mark,
  plus the wordmark) was deliberately **not** built: it spent a 50px row restating what the
  Dock icon and window title already say, and a mark on a coloured tile was the loudest
  object in a chrome whose premise is that nothing shouts. _Avoid_: brand block (the thing
  that does not exist), logo, header, workspace switcher (Kriyon has no workspaces).
- **Nav row** — one 30px destination row in the sidebar's nav block (icon · label · mono
  count): Sessions, Command centre, Prompts. The sidebar's replacement for the title bar's
  view switcher, so it sets the same `layout.view`. Focus is deliberately not one — it hides
  the chrome rather than naming a destination, so it is an icon button in the sidebar's top
  strip. _Avoid_: tab, menu item, nav link.
- **Anchored menu** (`useAnchoredMenu`) — a lightweight non-modal popover pinned to its
  trigger's own container (a project header, a session row), dismissed by Escape or an
  outside press. Unlike the modal `Overlay` shell it has no scrim and no focus trap: the
  hook owns the open/close state, the Escape + outside-`pointerdown` dismissal (against an
  anchor ref it returns), and the trigger's `aria-expanded`/`aria-haspopup`, while the
  popover stays absolutely positioned relative to its existing anchor. Adapters: the
  project [Palette menu], the per-project and global [Sort menu]s, and the session-row
  ⋯ overflow menu. _Avoid_: dropdown, flyout, popup.
- **Header action** (`HeaderAction`) — one hover-revealed 22px icon button in a sidebar
  project header (sort, palette, new-worktree, new-session). Owns the reveal policy
  (`kr-reveal` unless pinned always-visible) and the trigger aria for an attached
  [Anchored menu]. _Avoid_: toolbar button, icon button (generic).
- **Sort menu** (`SortMenu`) — the Manual/Date/Name radio popover, one component with two
  adapters: the sidebar's global sort picker and each project header's override picker
  (which adds "Follow global").
- **Palette menu** (`PaletteMenu`) — the project color-picker popover (swatch grid +
  Automatic), an [Anchored menu] adapter on the project header.
- **Project menu** (`ProjectMenu`) — the project header's ⋯ popover, an [Anchored menu]
  adapter: Rename, *Park project* (see [Parked project]), and the ask that opens the [Clear
  project] confirm. _Avoid_: context
  menu, project settings.
- **Confirm dialog** (`ConfirmDialog`) — the app's one "are you sure?" modal: an
  {@link Overlay} panel with a title, a line of body copy and a Cancel/destructive pair.
  Adapters: the terminal's close-over-live-work warning and the [Clear project] confirm.
  A destructive decision is never asked from an [Anchored menu] — a confirm hanging off
  its trigger lands over whatever is beneath it. _Avoid_: alert, modal (generic).
- **Theme** (`Theme`) — one complete named palette (id, label, `appearance` light or dark,
  colors, and an optional terminal ANSI palette) defined as a file in `src/theme/themes/` and
  selected by the persisted `layout.themeId`. `applyTheme` publishes the palette as `--kr-*` CSS
  custom properties; every design token resolves through them, so switching restyles the app
  without re-rendering. A full theme is written as a [Palette spec] through `defineTheme`
  (ADR-0051). _Avoid_: skin, color scheme.
- **Theme registry** (`THEMES`) — the ordered list of shipped [Theme]s: the Steel family ([Steel]
  — the default — indigo, cool blue, teal, graphite), Steel Light, and the community palettes
  (Catppuccin Mocha and Latte, Dracula, Gruvbox Dark, Nord, One Dark, Rosé Pine, Solarized
  Light, Tokyo Night), plus `themeById`, which maps unknown or stale persisted ids back to the
  default so startup can never break on a theme id. _Avoid_: theme list.
- **Palette spec** (`PaletteSpec`) — the few colours a full [Theme] actually chooses (planes,
  hairlines, ink ramp, status hues, editor and syntax colours, accent, and light-or-dark).
  `defineTheme` in `src/theme/themes/define.ts` derives every other colour from it — the soft
  fills, washes and surface stops — with the same alpha rules `darkChrome` uses (ADR-0051).
  _Avoid_: palette (alone — that is the [Palette menu] or the command palette).
- **Terminal palette** (`TerminalPalette`) — a [Theme]'s sixteen ANSI colours for the xterm
  canvas. A light theme must have one, with white and bright white still readable on its plane;
  the Steel family has none and keeps xterm's defaults. _Avoid_: ANSI theme.
- **Theme picker** (`ThemePicker`) — Settings' grid of [Theme] previews, each drawn in that
  theme's own colours rather than the active one's. _Avoid_: theme switcher, theme menu.
- **Steel** — the default [Theme]: the steel-blue accent of the BisBig direction (ADR-0023),
  converted from the canvas's `oklch(… 225)` to hex because `applyTheme` derives
  `--kr-accent-rgb` from a 6-digit hex. The one [Accent] tuned for the cool chrome rather than
  the warm one it replaced. _Avoid_: blue (that is the existing cool-blue theme).
- **Style recipe** (`src/theme/recipes.ts`) — a pure `CSSProperties` builder for one recurring
  shape (`sectionLabel`, `row30`, `kvRow`, `iconButton`, `button`, `chip`, `kbd`, `pill`,
  `card`, `inputBox`, `statTile`), built from [Theme] tokens. What the app has instead of a
  component library: the ADR-0007 seam wants module-level style objects, so the shared thing is
  the object, not a component. Spread it and override — a recipe never renders anything.
  _Avoid_: variant, style preset, component (it is not one).
- **Accent** — the one brand hue of a [Theme] (primary buttons, logo mark, selection). In the
  Steel family it is the only thing that changes between themes; a full theme picks one from its
  own palette. Session status colors are deliberately not accent-driven: running takes the
  theme's own running hue — green in every theme but Rosé Pine, which has no green and uses its
  foam. _Avoid_: primary color, highlight.
