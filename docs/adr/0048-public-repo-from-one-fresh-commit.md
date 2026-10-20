# ADR 0048 — The public repo starts from one fresh commit, after an empty v0.12.0 root

**Date:** 2026-10-18
**Status:** Accepted. Builds on ADR 0045 (versions) and ADR 0046 (builds and feeds); updates
ADR 0026 (branch rules).

## Context

Phase 8 of the release plan makes Kriyon public. The private history has more than a thousand
commits, and some of them carry client names, home paths and files that were never meant to be
published. Rewriting every one of them can't be checked with confidence, so the plan chose a
fresh start: the public repo gets the current tree as one new commit, and the full history stays
private.

Three things depend on that choice:

- **The name.** The app's update feeds (`kriyon_core::update`), the workflows, the issue forms
  and the docs all name `github.com/LeafyCode/kriyon`. Installed builds read their feed from
  that address and can't be changed after they ship.
- **The version count.** The release script and git-cliff count from the latest `vX.Y.Z` tag
  (ADR 0045). A repo with one commit and no tag has nowhere to count from: `pnpm release beta`
  refuses to run, and git-cliff can't tell that the work since 0.12.0 calls for 0.13.0.
- **Releases made while private.** The test nightlies and their feed were signed with the
  throwaway test key (ADR 0046), which public builds refuse.

## Decision

- **Rename, then reuse the name.** The private repo becomes `LeafyCode/kriyon-private` and
  keeps the full history, its releases and its secrets. A new public `LeafyCode/kriyon` takes
  the old name, so no code changes. Creating it ends GitHub's redirect from the old name, so
  nothing reaches the private repo by accident.
- **Two commits, one with content.** The public history starts with an empty commit,
  `chore: start the public history at 0.12.0`, tagged `v0.12.0`. On top of it, one commit holds
  the whole tree as `feat: …`. The scripts then count from `v0.12.0`, see a `feat`, and number
  the first beta `0.13.0-beta.1` with no special case in the code. The tag marks where public
  history begins; 0.12.0 itself was never published here.
- **`main` stays at the root until the first stable release.** Every commit on `main` is a
  shipped version (ADR 0026), and no version has shipped from the public repo yet. `dev` holds
  the tree and is the default branch.
- **Nothing carries over from the private releases.** The public feeds start from
  `0.13.0-beta.1`, signed with the real update key, whose public half is committed in the same
  tree.
- **Settings that only work in a public repo on the free plan are turned on straight away:**
  rulesets for `dev` and `main`, the `prerelease` and `release` environments with their
  secrets, private vulnerability reporting, Discussions, and approval before outside
  contributors' workflows run.

## Consequences

- The changelog can't be built from commits for 0.13.0: git-cliff sees one `feat` commit. The
  0.13.0 entry is written from the private repo's history (`pnpm release draft` there) and
  passed with `--notes`. From 0.13.0 on, entries come from public commits as usual.
- `git blame` and `git log` in the public repo start at the fresh commit. Anyone who needs the
  older reasoning reads the ADRs and plans, which are part of the tree.
- Local clones and worktrees of the old repo keep `origin` pointed at `LeafyCode/kriyon`, which
  is now the public repo. Every branch in them carries the private history, so a plain
  `git push` would publish it as a new branch; the rulesets guard only `dev` and `main`. Before
  the public repo is created, every old clone repoints its remote
  (`git remote set-url origin git@github.com:LeafyCode/kriyon-private.git`; worktrees share
  their clone's remotes). Work for the public repo is then done in a fresh clone of it, and
  unpushed work moves over as a patch, never as a branch with the old history under it.
- Builds installed while private follow the public feeds, but those are signed with a different
  key, so they won't update. Only the maintainer had them.
