# ADR 0026 — `dev` is the integration branch; `main` only takes releases

**Date:** 2026-09-27
**Status:** Accepted

## Context

The v1 plan (`docs/superpowers/plans/2026-06-16-kriyon-v1.md`) and CI
(`.github/workflows/ci.yml`, which runs on pushes and PRs to `dev` and `main`)
were both written for a `dev` branch, and `AGENTS.md` told agents to "build on
the `dev` branch only". The branch was never created. In practice typed branches
(`feat/…`, `fix/…`) merged straight into `main`, and releases were cut on branches
that had not reached `main` yet, so `main` was neither "latest work" nor "latest
release". An agent following `AGENTS.md` literally had no branch to build on.

## Decision

Adopt a two-level branching model and make the written rule true:

- **`dev`** is the integration branch. All work branches from `dev` with a typed
  name (`feat/…`, `fix/…`, `docs/…`, `refactor/…`, `chore/…`) and merges back
  into `dev` by pull request.
- **`main`** only receives `dev` through a release pull request, so every commit
  on `main` is a shipped version.
- **No direct commits to `dev`, `main` or `master`.** lefthook's
  `protect-base-branches` job enforces this locally; CI already runs on both
  base branches.

`dev` was created from `origin/main` at `6c00366`.

## Consequences

- `AGENTS.md`, the `engineering-workflow` skill and `lefthook.yml` state and
  enforce one rule instead of two contradictory ones.
- Branches that were in flight when `dev` was created (for example
  `fix/appkit-exception-guard`, which carries the 0.9.0 and 0.9.1 releases) are
  merged into `dev` by PR, then released to `main` through a `dev` → `main` PR.
- lefthook only guards local commits. `dev` is the repository's default branch,
  a repository setting.

## Update — 2026-10-18: rulesets, from the public repo on

This ADR first said GitHub branch protection guarded `dev` and `main`. It
didn't: on the free plan a private repo gets neither branch protection nor
rulesets, so only lefthook enforced the rule. Since the repo went public
(ADR 0048), rulesets do:

- **`dev`**: changes only by pull request, squash merge only, required checks
  must pass.
- **`main`**: changes only by pull request, merge commits only (a release PR
  brings `dev` over as it is), required checks must pass.
- **Both**: no force push, no deletion, 0 required approvals. GitHub never lets
  you approve your own pull request, so 1 would block every one the maintainer
  opens. Raise it to 1 when a second maintainer joins.
