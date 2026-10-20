# ADR 0018 — The product website lives in `website/` as its own pnpm root, not a turborepo

**Status:** accepted · 2026-07-31

## Context

Kriyon needs a product website (the website design).
Two placements were considered:

1. Convert the repo to a turborepo monorepo (`apps/desktop`, `apps/website`, `turbo.json`).
2. Add a `website/` folder inside the existing repo.

Facts that decided it:

- The desktop app and the website share **no code**. The site duplicates four accent-color
  values; that is the entire overlap. Turborepo's value — task graphs and caching across
  interdependent packages — has nothing to bite on with two unrelated packages.
- The root is a working single-package Vite + Tauri app with tuned tooling
  (`pnpm-workspace.yaml` overrides, lefthook jobs, CI). Restructuring it into `apps/*`
  churns every path reference for zero functional gain, and this checkout is shared by
  multiple live agent sessions.
- Deploy hosts (Vercel/Netlify/Pages) take a sub-directory root natively, so `website/`
  deploys independently either way.

## Decision

`website/` is a **self-contained pnpm project inside the repo**:

- Its own `pnpm-workspace.yaml` (comment-only marker) stops pnpm's upward workspace lookup,
  so it keeps its **own lockfile** and never joins the app workspace. Root install, CI, and
  the app lockfile are untouched.
- **No nested Biome config.** The root Ultracite/Biome config formats and lints
  `website/**` like any other frontend file (Biome rejects nested roots — see the
  `.claude/worktrees` note in `biome.jsonc`), and the lefthook `frontend-format-lint`
  job already covers staged website files.
- TypeScript is scoped per project: root `tsconfig.json` includes only `src`, the website's
  `tsconfig.json` includes only its own `src`. The website checks itself via
  `pnpm typecheck` / `pnpm check` run inside `website/`.
- Stack: TanStack Start (React) with static prerendering enabled — the site is fully
  prerendered marketing content; no server functions.

## Consequences

- One `git clone` carries app + site; a website PR never blocks on app tooling.
- Contributors run `pnpm install` twice (root and `website/`) — accepted cost of lockfile
  isolation.
- If the site ever grows real shared packages (a design-token package, shared components),
  graduating to a workspace/turborepo is additive from this layout; nothing here blocks it.
