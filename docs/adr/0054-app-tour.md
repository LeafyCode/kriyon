# ADR 0054 — App tour: a built-in spotlight tour, shown once to everyone

**Date:** 2026-11-01
**Status:** Accepted

## Context

Kriyon's window has many parts that are not obvious on first sight: the
session tree, worktree sessions, the Command center, three ways to follow a
session, Project terminals, the Details rail with Activity and Notes, the
command palette and Focus mode. A new person sees a terminal and a sidebar and
has to discover the rest by accident. People who already use Kriyon also asked
for a way to see what they may have missed.

We wanted a short tour that touches every part of the window, opens on its own
for someone new, and can be replayed by anyone.

## Options considered

- **A tour library.** driver.js (MIT, no dependencies) and react-joyride are
  the usual choices; Shepherd.js and Intro.js are AGPL or paid for commercial
  use, which does not fit an Apache-2.0 app. Even the MIT ones bring their own
  stylesheet and popover markup, which would sit outside the theme seam
  (ADR-0007): every colour would need overriding with `!important` rules to
  follow the twenty themes, and the card would not look like the rest of the
  app.
- **Build it.** A spotlight is one absolutely placed box with a very large
  `box-shadow` in the theme's scrim colour; the card is a panel built from the
  existing tokens and recipes. The placement maths is a small pure function.

## Decision

- **Build it, in `src/tour/`.** `placement.ts` holds the geometry (which side
  of its target the card goes, kept inside the window) and is unit-tested
  without rendering. `steps.ts` lists the steps. `AppTour.tsx` measures the
  target and renders. `state/tour.ts` holds which step is showing.
- **Steps point at `data-tour` attributes**, not test ids or class names, so a
  restyle cannot silently break the tour and a reader of a component can see it
  is a tour stop. A step whose target is missing or hidden (no session open, a
  collapsed sidebar) shows its card in the middle of the window, so the tour
  never breaks on an empty or rearranged window.
- **Motion:** the spotlight and the card glide between steps on one shared
  easing, the lit target carries a soft pulsing ring, and each step's text
  fades up. The global reduced-motion rule in `App.css` turns all of it off.
- **Keyboard:** → and Enter move on, ← goes back, Escape skips. The keys are
  caught in the capture phase so they never reach a focused terminal.
- **Shown once, by default, to anyone who has not seen it.** `layout.tourSeen`
  is saved with the rest of the layout. A fresh install starts with it
  `false`, and so does a layout saved before this field existed: people who
  used Kriyon before the tour never saw it either, so it opens for them once
  after the update. The tour waits for hydration to read the layout
  (`useTour.noteLayoutLoaded`) before deciding, and it only mounts after the
  welcome screen's consent.
- **Replay from three places:** Help → Kriyon Tour in the macOS menu (the
  submenu uses Tauri's help-menu id, so macOS adds its Help search), the
  command palette's "Take the app tour", and Settings → Layout → App tour.

## Consequences

- A new part of the window should get a step and a `data-tour` attribute, or
  the tour falls behind the app.
- The tour starts on the session workspace; it switches there from Settings,
  Prompts, the Command center or Focus. It does not open or collapse panels
  for the person, so a step aimed at a hidden part shows centred.
