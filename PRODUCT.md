# Product

## Register

product

## Users

A developer running their own authenticated `claude` CLI. They live in the terminal and are comfortable there — Kriyon doesn't replace the terminal, it wraps it. Mac-first. They run several Claude sessions across projects and worktrees at once and want to see, at a glance, which session needs them without losing the real terminal as the source of truth.

## Product Purpose

Kriyon is a Tauri v2 desktop GUI that hosts the user's real `claude` CLI in a live PTY terminal. It manages multi-project / multi-session / worktree workflows: a sidebar of workspaces, a Changes view of what each session actually changed on disk, an Inspector of live activity (subagents, background shells, tasks, usage), and a composer that writes straight to the session's stdin. Success is the app disappearing — the user works in the real terminal and turns to the Changes view to see what came of it, while Kriyon tracks which of many concurrent sessions needs them and stays fast under all of them.

## Brand Personality

Precise, calm, native. The voice of a first-party macOS developer tool, not a flashy AI product. Quiet confidence: it shows state plainly and gets out of the way. Restraint is the personality — the interface earns attention only when a session needs it.

## Anti-references

- SaaS-cream marketing gradients and hero-metric templates — this is a tool, not a landing page.
- Neon / cyberpunk glow, drenched purple, "AI app" maximalism.
- Heavy decorative glassmorphism — blur and translucency are a material, used once for real depth, never piled on.
- Anything that reads as loud or busy. If a glow, gradient, or motion isn't carrying information, it doesn't belong.

## Design Principles

- **The terminal is the source of truth.** Everything Kriyon derives around it — status, the Changes view, usage — is best-effort; it never fights or overrides the real output.
- **Accent punctuates, never decorates.** One purple, spent only where it carries meaning (active session, running state, primary action). Everywhere else is the neutral ramp.
- **Restraint over decoration.** Hairline borders, flat surfaces, tight depth. Reach for nothing extra; remove before adding.
- **Native, not novel.** It should feel like it shipped from Cupertino — familiar macOS instincts, no invented chrome.
- **Performance is a feature.** Buttery under many concurrent sessions. No effect ships if it costs frames; blur, shadow, and motion are budgeted, not free.

## Accessibility & Inclusion

- WCAG AA contrast for body and UI text against its actual surface.
- `prefers-reduced-motion` honored for every animation (already enforced globally).
- Keyboard-first: command palette (⌘K) and full keyboard reach for primary flows.
- Dark by default (a focused, low-light developer surface), with light themes too; every theme passes the same contrast tests, and contrast carries hierarchy, not color alone.
