# ADR 0043 — Pull request checks for a public repo

**Date:** 2026-10-14
**Status:** Accepted

## Context

Kriyon is about to become a public repository that takes pull requests from
people we don't know. CI ran lint, types and tests on Linux only, although the
app ships for macOS. Nothing checked the PR title (which becomes the squash
commit on `dev`), the Rust dependency tree, or the workflow files themselves,
and nothing kept dependencies up to date.

Some of the tools we want are free only on public repositories: macOS runners
cost ten times the Linux rate on a private repo, and code scanning (CodeQL,
Scorecard's upload) needs GitHub Advanced Security there.

## Decision

Every pull request into `dev` or `main` runs, alongside the existing checks:

- **PR title** (`pr-title.yml`): a conventional commit, same types as
  commitlint, subject starting lower-case. Dependabot's "Bump …" is the one
  exception, since it can't be told to write the word in lower case.
- **macOS** (`ci.yml`): clippy, the tests single-threaded (as
  `pnpm rust:test`), and an unsigned debug app build.
- **cargo-deny** (`ci.yml`, `deny.toml`): fails on a security advisory, an
  unmaintained crate, a licence outside the allow-list, or a crate from an
  unknown source. It checks the two macOS targets only, since Kriyon ships for
  nothing else. Kriyon's own crates are `publish = false`.
- **zizmor** (`ci.yml`): audits the workflow files; findings fail the job.
- **CodeQL** (`codeql.yml`): Actions, TypeScript and Rust, read without a build.

**Scorecard** (`scorecard.yml`) is not a pull request check: it runs on pushes
to `dev`, the default branch (the action refuses any other), and weekly, and
publishes the score.

Dependabot proposes weekly grouped updates for npm (app and website), Cargo
and Actions into `dev`, each held for 7 days after release. Tauri's npm
packages and Rust crates get only patch updates from it: `tauri build` refuses
the two sides on different minor versions, and Dependabot bumps each ecosystem
in its own pull request, so a minor or major Tauri bump is done by hand, both
sides in one pull request.

Rules every workflow follows: `permissions: {}` at the top and only what each
job needs; actions pinned to a full commit SHA with a version comment;
`persist-credentials: false` on checkout; never `pull_request_target`.

Jobs that cost money or need Advanced Security while the repo is private are
gated on `!github.event.repository.private`. The macOS job can also be started
by hand (`workflow_dispatch`) so it can be tested before launch.

## Consequences

- The gated jobs switch on by themselves when the repo goes public. Until then
  a green private run does not prove the macOS build; run it by hand before
  release.
- These are repository settings, not code, and are set on the new public repo
  at launch: require approval before CI runs for outside contributors;
  rulesets on `dev` (PR required, checks pass, squash only) and `main` (PR
  required, checks pass, merge commits only), both with no force push and no
  deletion, and 0 required approvals until a second maintainer joins; the
  Scorecard badge in the README.
- A new advisory in a dependency can turn CI red with no code change. Fix it
  by updating the crate, or add it to `deny.toml`'s `ignore` with a reason.
