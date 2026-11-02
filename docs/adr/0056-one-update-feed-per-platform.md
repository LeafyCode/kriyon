# ADR 0056 — One update feed per platform

**Date:** 2026-11-02
**Status:** Accepted. Changes the feed layout of ADR 0046 and the endpoints of ADR 0047.

## Context

ADR 0046 gave each channel one feed file, `latest.json`, and ADR 0055 added Windows to it. One
file for every platform ties them together:

- The Tauri updater (`tauri-plugin-updater` 2.14, `updater.rs`) reads the whole file. If its
  version is an update but the file has no entry for the running platform, `check()` fails with
  `TargetNotFound`, so the person sees a failed check, not "no update".
- So every release had to carry every platform. A Windows build failure blocked a Mac release,
  and an urgent fix for one platform could not ship without also building, and offering, the
  other.
- The file holds only the newest version. Even with the missing-platform case handled, a
  Windows-only 0.16.2 would hide a Mac-only 0.16.1 from Macs still on 0.16.0.

Other desktop apps keep platforms apart:

- electron-builder writes `latest.yml` (Windows), `latest-mac.yml` and `latest-linux.yml`, one
  per platform.
- VS Code asks its update service per platform (`/api/update/<platform>/<quality>/<commit>`),
  and Zed passes the OS and arch to its server.
- Tauri apps Yaak (`update.yaak.app/check/{{target}}/{{arch}}/{{current_version}}`) and
  GitButler (`…/releases/nightly/{{target}}-{{arch}}/{{current_version}}`) use the updater's
  endpoint templating, which the Tauri docs describe for exactly this.

## Decision

- **One static feed file per platform per channel**, on that channel's fixed pre-release:
  `feed-stable`, `feed-beta` and `feed-nightly`, each holding `darwin.json` and `windows.json`.
  The app's endpoint is `…/releases/download/feed-<channel>/{{target}}.json`; the updater fills
  in `darwin` or `windows`. Still GitHub Releases only: no server to run.
- **Stable gets a fixed `feed-stable` release** like the others, instead of
  `releases/latest/download/…`. "Latest release" is one release for every platform, so it
  can't follow two platforms that ship different versions.
- **A release can be built or published for one platform.** Each build uploads its feed file
  last, once all its checks pass, and a failed build removes its files from the draft. Betas
  and nightlies publish for whichever platforms finished; a run by hand can build one platform.
  Stable builds both, and Publish can publish one, removing the other's files first.
- **The feed check is per platform**: a platform's required entries, every entry complete and
  signed for the version, and no other platform's entries.
- **No entry for this platform reads as no update** in the app (`for_this_platform` in
  `update_rt.rs`), so a partial or broken feed never shows an error.
- **One version sequence.** A platform-only release uses up its number on the other platform.
- **Old Mac builds keep their feed.** Builds up to 0.15.0 read `latest.json`. Every Mac build
  still uploads it to its release, which stays GitHub's latest release only when it has a Mac
  build, and publishing copies it to `feed-beta` and `feed-nightly`. Their first update moves
  them to the new feeds. No Windows build has shipped with the old endpoint, so Windows has no
  legacy file.
- **No feed file is ever missing.** Each publish fills in any channel's missing `darwin.json`
  from that channel's `latest.json`, and any missing `windows.json` with the same version and no
  entries. A missing file would be a 404, which the updater reports as a failed check, for
  example when someone on a new beta switches to stable before the first new stable ships.
- **The Windows download link** is `feed-stable/Kriyon-setup.exe`, put there when a stable
  Windows build is published, since `releases/latest` may be a Mac-only release.

## Consequences

- An urgent fix ships for one platform without waiting for, or bothering, the other.
- Two more files per channel to keep in step, and the publish script and its tests grew.
- Version numbers can skip on a platform; the changelog entry says which platform a version is
  for.
- `latest.json` is dead weight once no 0.15.0 or older build is left; drop it then. From the
  fourth stable release after 0.15.0, Publish warns in its run summary as a reminder.
- A small update server (rollbacks, staged rollouts) stays possible later: the app's endpoint
  is the only thing that would change.
