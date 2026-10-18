# ADR-0007: Themes are published as CSS custom properties, not re-rendered state

## Status

Accepted (2026-07-04).

## Context

The UI Refresh design ships one dark chrome with four selectable accents
(indigo, cool blue, teal, graphite), and the theme set should be user-extendable
later. All 40+ view files style themselves with module-level
`const style: CSSProperties = { …tokens… }` objects — evaluated once at import
time. Any theming approach that changes the *values* inside `tokens` at runtime
(a Zustand store, a ThemeProvider context) would leave every module-level style
object stale unless all of them were converted to per-render style factories —
a sweeping, regression-prone rewrite of the whole frontend.

## Decision

`tokens.ts` keeps its shape but every color value becomes a `var(--kr-*)`
reference. A theme is a plain data file in `src/theme/themes/` holding concrete
values for every `ThemeColors` key; `applyTheme` writes them onto
`document.documentElement`. Switching themes rewrites the custom properties and
the browser restyles everything — zero React re-renders, module-level style
objects stay valid.

Two seams need concrete (non-variable) colors and read the active `Theme`
object directly:

- **xterm** paints to a canvas and cannot resolve CSS variables →
  `terminalTheme(theme)`, re-applied on theme switch.
- **Alpha composition**: `accentAlpha(a)` composes `rgba(var(--kr-accent-rgb), a)`
  from a triplet that `applyTheme` derives from the accent hex.

The persisted `layout.themeId` is validated through `themeById`, which falls
back to the default for unknown ids, so a stale persisted value can never break
startup.

### Extension: motion durations publish through the seam too

Motion durations/easings publish through the same seam as `--kr-motion-panel`,
`--kr-motion-disclose`, and `--kr-motion-hover`. Unlike colors, motion is
**theme-independent**: `applyTheme` re-publishes one concrete `MOTION` constant
map on every call (harmless on a theme switch, mirroring how gradients/shadows
are built from concrete values in `applyTheme`). `tokens.motion` holds
`var(--kr-motion-*)` references, and `App.css` references the same variables —
so the previous "`0.18s ease` mirrors `tokens.motion.disclose`; keep the two in
lockstep" comment drift in `App.css` is gone: the seam now enforces it.

## Consequences

- Adding a theme = one data file + a registry entry; the type system enforces
  palette completeness.
- Tests that read colors back from the DOM assert `var(--kr-*)` identity (or
  theme-file values), not resolved rgb — jsdom does not resolve custom
  properties.
- A future light theme is a palette file away, but shadows/blur stay static in
  `tokens.ts` until a real light theme forces the question (YAGNI).
