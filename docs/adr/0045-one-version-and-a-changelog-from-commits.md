# ADR 0045 — One version, picked from the commits, with a hand-written changelog

**Date:** 2026-10-15
**Status:** Accepted; amended by [ADR 0046](0046-release-builds-and-update-feeds.md)
(publishing the release makes the tag; nobody pushes it by hand) and by
[ADR 0048](0048-public-repo-from-one-fresh-commit.md) (the public repo's `v0.12.0` is an empty
root commit, not the commit that holds the tree)

## Context

Until 0.12.0 every release was cut by hand: someone chose the next number, edited
`package.json` and the website's `APP_VERSION`, and wrote the `CHANGELOG.md` entry from
memory. The three crates stayed at 0.1.0, so the Rust side never knew the app's version. The
repo had no tags, so nothing could say which commits a release held.

The public release adds builds from CI (Phase 6 of the release plan): stable releases from
`main`, betas and nightlies from `dev`. Each needs a version nobody types, and two nightlies on
one day must not clash.

release-please was the first choice and was dropped: it follows one branch, so it can't number
betas and nightlies from `dev`; its bot pull requests don't trigger CI without an extra GitHub
App; and it opens its own release pull request on `main`, which ADR 0026 doesn't allow.

## Decision

- **One version everywhere.** `package.json` holds it (Tauri reads it from there). The crates
  take it from `[workspace.package]` in the root `Cargo.toml`; `Cargo.lock` and the website's
  `APP_VERSION` carry the same number. The workspace's crates are the ones `Cargo.lock` lists
  without a `source`, so a new crate is covered without being named. `scripts/release.test.mjs`
  fails when any of them differ, and runs in `pnpm check`, the pre-push hook and CI.
- **git-cliff picks the version and drafts the entry** from the conventional commit titles
  since the last release tag. `cliff.toml`'s `tag_pattern` (`v<x.y.z>`) is the one definition
  of a release tag; the script reads it too. `feat` bumps the minor number, `fix` the
  patch. Before 1.0 a breaking change bumps the minor number too. The draft groups changes as
  Keep a Changelog does (Added, Changed, Removed, Fixed, Security), hides `chore`, `test`,
  `ci`, `refactor`, `docs`, `style` and `build`, shows any breaking change whatever its type,
  and thanks anyone outside the team by name.
- **A person always rewrites the entry.** The draft is a list of commit titles; the shipped
  entry is plain words in the voice the 0.12.0 entry set. `pnpm release` won't commit an
  entry that is empty under its heading or headed with another version.
- **`pnpm release` cuts a stable release through the normal flow**: from an up-to-date `dev`
  it makes `chore/release-<version>`, sets the version, adds the entry and commits. Every
  check runs before the branch is made, so a refusal changes nothing. That
  branch goes into `dev` by pull request, then `dev` into `main` by the release pull request
  (ADR 0026). Nothing is pushed by the script.
- **The tag goes on the `dev` commit `main` took**, not on `main`'s merge commit, so it stays
  reachable from `dev`, where git-cliff counts commits from it. `node scripts/release.mjs
  released` finds it as the merge base of `origin/main` and `origin/dev`. It refuses when
  `main` holds changes `dev` doesn't, or when `main` took a change merged into `dev` after
  the newest `chore(release)` commit that a user would see: that change shipped but its entry
  doesn't list it, and git-cliff, counting from the tag, never would. A follow-up
  `chore(release): <version>` pull request that adds it to the entry clears the refusal.
  (Amended by ADR 0046: the release workflow runs this check, and publishing the draft
  release makes the tag. Before, `pnpm release tag` tagged locally and a person pushed it.)
- **Pre-releases use the same next version**: `<version>-beta.<N>`, N one past the highest
  existing beta tag of that version, and `<version>-nightly.<YYYYMMDD>.<run>`, with the UTC
  date and the CI run number. When no commit calls for a bump, the base is the next patch.
  Pre-release tags never close a changelog section or move the base. `--write` sets the
  version in the working tree for a build and commits nothing.
- **v0.12.0 is the first tag**, on `3e8aaa7`, the merge that took the 0.12.0 release into
  `main`. It predates the merge-base rule, and `dev` already holds that commit, so git-cliff
  on `dev` counts from it all the same. Its `package.json` and `CHANGELOG.md` say 0.12.0.
  It serves this private repo until the move. The public repo starts from one fresh commit
  that shares no history with this one, so that commit gets its own tag for the version it
  holds, set when the public repo is made (Phase 8). Without it git-cliff there would count
  from the first commit.

## Consequences

- A PR title now decides the next version as well as the changelog line, so its type matters
  more. `engineering-workflow/shipping.md` says so; `pr-title.yml` already enforces the format.
- git-cliff is a pinned dev dependency, so the same version runs locally and in CI.
- The `release` skill walks an agent through the same steps and stops for the person's yes
  before every push, pull request and tag.
- Phase 6 builds on this (ADR 0046): the release workflow runs the tag checks, and the beta
  and nightly jobs call `node scripts/release.mjs beta --write` or `… nightly --write`, which print only the
  version on stdout (`pnpm release` adds a banner of its own). They set `Cargo.lock` by
  text, so they need no Rust toolchain, but they do need the full git history and tags
  (`fetch-depth: 0`) to count betas and find the base.
