# ADR 0046 — Release builds from CI, published from drafts, with checked update feeds

**Date:** 2026-10-16
**Status:** Accepted. Extends ADR 0045 and changes who makes the stable tag.

## Context

Until now a release was built on a laptop with `pnpm release:mac`, then shared by hand.
Phase 6 of the release plan moves that into GitHub Actions for three channels: stable from
`main`, betas and nightlies from `dev`. ADR 0045 already numbers all three. Phase 7 adds the
in-app updater, which reads one small feed file (`latest.json`) per channel. A bad feed, such
as a wrong signature or a missing chip, reaches every installed app at once, and an app that
can't verify its update can never update again. So the feed has to be checked before anyone
can get it.

The repo is private on the free plan until it goes public (Phase 8). That rules out
environment secrets, required approvals, branch rules on environments and artifact
attestations until then, and macOS runners cost ten times the Linux rate.

## Decision

- **One universal build** (Apple Silicon and Intel) per release on a macOS runner, through
  `tauri-apps/tauri-action` v1, the same way `pnpm release:mac` builds: both Rust targets,
  and `KRIYON_SIDECAR_TARGET=universal-apple-darwin` so `kriyon-ptyd` covers both chips. Tauri
  signs the `.app` with the Developer ID. The workflow then notarizes the DMG with an App
  Store Connect API key and staples its ticket, retrying until Apple has published it.
  Apple notarizes and staples only the outermost container: the DMG's ticket covers the app
  inside, and macOS takes it in when the DMG is opened. (Tauri's own staple of the `.app`
  is never checked and failed in CI, so Tauri isn't asked to notarize at all.)
  `scripts/check-mac-bundle.sh` stops the release unless the app says the version being
  released (the guard), the app and the helper hold both chips and are signed, Gatekeeper
  accepts the app and the DMG as notarized, and the DMG has its ticket stapled.
  `pnpm release:mac` runs it too.
- **Every update file is signed with the Tauri update key.** Release builds merge
  `src-tauri/tauri.updater.conf.json`, which turns on `createUpdaterArtifacts` and holds the
  public key. Local and CI test builds don't merge it, so they need no private key.
- **A test key while private, the real key from Phase 8.** Every build in this private repo
  is a trial, and the public repo starts from a fresh commit. So the committed key is a
  throwaway, never backed up, and the real key is made with the public repo and stored only in
  its environments. One copy fewer to guard. Forgetting the swap would ship apps that trust an
  unguarded key, so both workflows run `scripts/publish.mjs check-key`, which refuses the test
  key (by its id) once the repo is public. They read visibility from the API, because a
  scheduled run's event doesn't carry it.
- **Every build lands as a draft release in this repo**, never in a separate releases repo:
  once public, its releases are open to everyone. The tag doesn't exist yet. Publishing the
  draft makes the tag, on the commit the draft names. A failed run leaves no tag. A re-run gets
  the same version (a nightly takes the run number and the run's start date, and neither
  changes on a re-run), so it deletes the draft the failed run left and builds again. A published release is never replaced: a download link
  always gives the same bytes.
- **Stable waits for a person.** A push to `main` that carries a new version builds the draft.
  It first runs `node scripts/release.mjs released`, the checks `pnpm release tag` used to
  run, and the draft names the `dev` commit `main` took, as ADR 0045 asks. A person checks the
  draft (they can edit the notes there), then runs the Publish workflow. The version is
  built into the app, so changing it means deleting the draft and cutting the release again.
  Nobody pushes a tag by hand any more; `pnpm release tag` is gone.
- **Betas and nightlies publish themselves.** A beta runs when someone presses "Run workflow".
  A nightly runs every night, and skips when a nightly tag already points at `dev`'s head. Both
  set their version with `node scripts/release.mjs beta|nightly --write`. Only the newest 7
  nightlies are kept, newest in version order, so the one the nightly feed names is always
  kept.
- **The feed is checked before it moves.** `scripts/publish-release.sh` runs
  `node scripts/publish.mjs check-feed` on the draft's `latest.json`. It needs both Mac entries,
  every entry complete, each file downloaded and its minisign signature valid for the public
  key, and the version in the signature's trusted comment equal to the feed's version. That is
  what the updater checks with `requireSignedVersion`. Only then is the draft published. The
  build job runs the same check, so a stable draft is known good before anyone looks at it.
- **Where the feeds live.** Stable uses GitHub's latest-release link
  (`releases/latest/download/latest.json`), which ignores pre-releases and drafts, so it moves
  only when a stable release is published. Betas and nightlies each have one fixed pre-release,
  `feed-beta` and `feed-nightly`, that holds only their `latest.json`. Publishing replaces that
  file. A stable release goes on `feed-beta` too, so beta users land on it and then get the
  next beta.
- **One run per channel at a time.** Both workflows share a concurrency group per channel
  (`release-stable`, `release-beta`, `release-nightly`) and never cancel a run halfway.
  GitHub keeps one waiting run per group and drops an older waiting one, so per channel the
  newest waiting run wins, and a nightly never displaces a stable build.
- **Publishing can be run again.** A release already published skips that step, so a run that
  failed after publishing finishes moving the feed, pruning and the tap. Feeds only move
  forward (semver, as the updater compares). A stable release becomes GitHub's latest release,
  which is the stable feed, only when it is the newest stable version, and the tap follows the
  latest release. So publishing an older release never points anyone back at it.
- **Release notes**: a stable release's `CHANGELOG.md` entry, which lists everything since the
  last stable release; a beta's or nightly's git-cliff draft, without its heading or guidance
  comment (`release.mjs notes`). A beta's draft lists only what is new since the previous beta
  (a nightly's, since the previous nightly), or since the last stable release when it is the
  first, and a release tagged in between is listed with it. So a tester who takes every beta
  sees what changed since the one they run; one who skipped a beta sees only the newest
  beta's changes, and the skipped one's are on its own GitHub release. They also become
  `latest.json`'s notes, which the update dialog shows.
- **Secrets are plain repo secrets while private.** The jobs already name two environments:
  `prerelease` for betas and nightlies, and `release` for stable builds, publishing and the
  Homebrew tap. A private repo on the free plan gets environments without rules, and repo
  secrets still reach them. Going public is a settings change: move the secrets into the
  environments, let only `dev` deploy to `prerelease` (no approval, so the nightly runs on its
  own), and let only `main` deploy to `release`, with an approval. Pull requests from forks
  never see either.
- **Build provenance** (`actions/attest-build-provenance`) for the DMG and the update file,
  once public. GitHub offers attestations to private repos only on Enterprise.
- **An own Homebrew tap**, `LeafyCode/homebrew-tap` (`brew install leafycode/tap/kriyon`).
  Publishing a stable release rewrites `Casks/kriyon.rb` from `scripts/publish.mjs cask`, so
  the cask's text lives in this repo. Until the tap and its token exist the step warns and
  skips.

## Pre-release versions in the Mac bundle

Tauri writes the whole version, `0.13.0-nightly.20261016.7` included, into both
`CFBundleShortVersionString` and `CFBundleVersion` (tauri-bundler `macos/app.rs`). Apple asks
for plain dotted numbers there for the App Store. Kriyon ships outside it with a Developer ID,
and the first CI nightly confirms that notarization takes the version as it is. The updater
compares versions as semver. Within one channel that orders correctly: run numbers and dates
compare as numbers, and `x.y.z` comes after all of its pre-releases. Across channels it
doesn't. `0.13.0-nightly.…` sorts after `0.13.0-beta.3` because `nightly` > `beta`, so
moving from nightly to beta looks like a downgrade. Phase 7's version check handles channel
switches (release plan, Phase 7).

## Consequences

- Phase 7 needs only the updater plugin, the channel's feed address and the UI. The feeds,
  signatures and checks already exist. The public key is in `tauri.updater.conf.json`; Phase 7
  decides whether it moves into `tauri.conf.json`.
- Losing the real update key's private half means installed apps can never update again, so
  it is backed up in two places (docs/RELEASING.md). A leak is worse: anyone holding it and able to
  serve a feed can ship an update. docs/RELEASING.md says what to do.
- While the repo is private, nightlies run only when started by hand, and every run costs
  macOS minutes. There is no dependency cache in these workflows, because a poisoned cache in
  a publish job would ship. So each build compiles from scratch.
- The release PR's merge no longer ends with a hand step. It ends with a draft and a Publish
  run, and the `release` skill says so.
