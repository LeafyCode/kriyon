# ADR 0051 — Full colour themes: a light theme and community palettes

**Date:** 2026-10-31
**Status:** Accepted
**Amends:** [ADR-0023](0023-bisbig-visual-direction.md) (the chrome is no longer always dark)

## Context

Every theme Kriyon shipped was the same dark BisBig chrome with a different
accent. People asked for a light theme, and for the palettes they already use
in their editor and terminal (Dracula, Nord, Catppuccin and so on). The theme
seam (ADR-0007) already carried every colour as a `--kr-*` property, so the
cost was in the palettes, not the plumbing.

## Decision

- **A [Theme] can replace the whole palette**, not just the accent. Each one
  says whether it is `light` or `dark`; `applyTheme` sets the webview's
  `color-scheme` from that and publishes `--kr-contrast-rgb` (white or black),
  which CSS uses for washes and scrollbar thumbs instead of hard-coded white.
- **Full themes are written as a short spec** (`themes/define.ts`): planes,
  lines, a six-stop ink ramp, status hues, editor and syntax colours, and the
  accent. Soft fills, washes and surface stops are derived, so the alpha rules
  live in one place.
- **A full theme brings its own code colours and terminal ANSI palette.** The
  Steel family keeps one shared code palette across accents, as before; for
  Dracula or Solarized the code colours are half of what the theme is.
- **Shipped:** Steel Light (from BisBig's light tokens), Catppuccin Mocha and
  Latte, Dracula, Gruvbox Dark, Nord, One Dark, Rosé Pine, Solarized Light
  and Tokyo Night — all MIT-licensed palettes.
- **Every theme passes the same contrast tests**: muted ink at 4.5:1 on the
  plane and rails, dim ink at 3:1, code ink at 4.5:1 on its well, and the
  accent's label at 3:1 on the accent.

## Consequences

- Teal's button label moved from near-white to the dark plane colour, which
  the new accent-label test caught at 2.9:1.
- A light theme's terminal white and bright white must read at 3:1 on its plane.
  Catppuccin Latte and Solarized Light ship darker whites than their upstream
  palettes for that reason: Solarized's own bright white is its background.
- The code editor follows `appearance` too, because CodeMirror's own dark-mode
  styles outrank Kriyon's in places (a focused selection).
- The mascot's thought bubbles follow the plane; the rest of the mascot does not.
- Claude Code draws its own output in the terminal with the colours of its
  own `/theme` setting. On a light Kriyon theme, Claude should be set to a
  light theme too; Kriyon does not change Claude's settings.
- The project identity colours and the composer's token pills stay the same
  in every theme.
