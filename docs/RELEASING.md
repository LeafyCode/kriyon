# Releasing Kriyon

How a build gets from `dev` to people's Macs and Windows PCs. Why it works this way is in ADR
0045 (versions and the changelog), ADR 0046 (builds, publishing and feeds) and ADR 0056 (one
feed per platform).

| Channel | Built from | When | Who publishes |
|---|---|---|---|
| Stable `0.13.0` | `main` | The release PR is merged | A person, with the Publish workflow |
| Beta `0.13.0-beta.1` | `dev` | Someone runs the Release workflow, channel beta | The workflow, once its checks pass |
| Nightly `0.13.0-nightly.20261016.41` | `dev` | Every night at 03:17 UTC, if `dev` changed | The workflow, once its checks pass |

Each run makes one draft release, then builds the Mac app and the Windows installer side by
side into it:

- **Mac:** a universal (Apple Silicon and Intel) app, signed with the Developer ID, notarized,
  and checked by `scripts/check-mac-bundle.sh`. It adds the DMG, the signed update file
  (`Kriyon.app.tar.gz` and its `.sig`), `latest.json` and `darwin.json`.
- **Windows:** an x64 NSIS installer, `Kriyon_0.13.0_x64-setup.exe`, its `.sig` and
  `windows.json`. Windows builds are not code-signed yet (ADR 0055), so SmartScreen shows
  "Windows protected your PC" until someone clicks More info, then Run anyway.

Each build checks its feed file and uploads it last, so a `darwin.json` or `windows.json` in the
draft means that platform passed every check. A build that fails takes its files back out of
the draft (`scripts/drop-platform.sh`), and **one platform failing never stops the other**: the
release goes out for the platforms that finished. Nothing reaches anyone until the draft is
published, and publishing first checks each feed file again.

The DMG is uploaded twice: once with its version in the name (`Kriyon_0.13.0_universal.dmg`,
which the Homebrew cask uses) and once as `Kriyon.dmg`. The website's download button links to
`https://github.com/LeafyCode/kriyon/releases/latest/download/Kriyon.dmg`, which always serves
the newest stable Mac release: only a stable release with a Mac build becomes GitHub's latest
release. Publishing a Windows build puts its installer on its channel's feed release as
`Kriyon-setup.exe`, so each channel's newest Windows installer has a fixed link, for example
`https://github.com/LeafyCode/kriyon/releases/download/feed-beta/Kriyon-setup.exe`. Stable
lands on `feed-beta` too, so that link is the newest of beta and stable. The website's Windows
button uses it, with a BETA tag, while Windows is in beta (`WINDOWS_SETUP_URL` in
`website/src/lib/site.ts`); once Windows ships stable, point it at `feed-stable` and drop the
tag. Never use `releases/latest/download/…` for Windows: a Mac-only release would leave it
without one.

Update feeds, which the in-app updater reads (ADR 0047, ADR 0056), one file per platform on
each channel's fixed pre-release. The app asks for `{{target}}.json`, which the updater fills in
as `darwin.json` or `windows.json`:

- Stable: `https://github.com/LeafyCode/kriyon/releases/download/feed-stable/darwin.json`
  (and `windows.json`)
- Beta: `…/releases/download/feed-beta/darwin.json` (and `windows.json`). A stable release goes
  here too, so beta users land on it.
- Nightly: `…/releases/download/feed-nightly/darwin.json` (and `windows.json`)

Every publish run also fills in any of these six files that is still missing, so no build ever
reads a file that isn't there, which would show as a failed check. A missing `darwin.json` is
made from that channel's `latest.json`; the first run puts 0.15.0 on `feed-stable`. A missing
`windows.json` gets the same version with no entries, which the app reads as no update, until
the first Windows build for that channel replaces it.

Builds up to 0.15.0 read the older single `latest.json`, which carries the Mac entries only:
stable's from `releases/latest/download/latest.json`, beta's and nightly's from
`feed-beta/latest.json` and `feed-nightly/latest.json`. Publishing still writes those for every
Mac build, so those Macs keep updating, and their first update moves them to the new feeds.
Stop writing them (and delete them from the feed releases) once nobody runs 0.15.0 or older;
until then they cost nothing. From the fourth stable release after 0.15.0, Publish leaves a
warning in its run summary as a reminder to check.

### Versions when only one platform ships

Mac and Windows share one version sequence. A release that ships for one platform only uses up
its number on the other: if 0.16.1 goes out for the Mac alone, Windows goes from 0.16.0 to
0.16.2. Say "macOS only" or "Windows only" at the top of that version's changelog entry, so
nobody looks for the other download.

## Ship a stable release

1. Cut it with the `release` skill or by hand: `pnpm release` from an up-to-date `dev`, PR
   into `dev`, then the release PR from `dev` into `main`.
2. The merge starts **Release**, which builds both platforms. It refuses if `main` took a
   user-facing change the changelog entry doesn't list: add it to the entry in a
   `chore(release): <version>` PR into `dev`, then take `dev` into `main` again. Otherwise it
   leaves a draft `v<version>`.
3. Check the draft on GitHub: notes, files, and if you like, install the DMG or the setup.exe.
   You can edit the notes there. The in-app update dialog shows the notes from the feed files,
   which came from `CHANGELOG.md`, so fix big mistakes in the changelog, not only on the draft.
   To change the version, delete the draft and cut again: the version is built into the app.
4. Run **Publish** on `main` with the tag:
   `gh workflow run publish.yml --ref main -f tag=v0.13.0`. It checks each feed file,
   publishes (GitHub makes the tag), moves the stable and beta feeds, puts the Windows installer on
   `feed-stable/Kriyon-setup.exe` and `feed-beta/Kriyon-setup.exe` and, for a Mac build, bumps the Homebrew tap.

## Ship an urgent fix for one platform

- **Stable:** cut and merge the release as usual; Release builds both. Then publish only the
  one that needs it: `gh workflow run publish.yml --ref main -f tag=v0.13.1 -f platforms=mac`
  (or `windows`). The other platform's files are removed from the draft first, so its users
  are not offered a version that changes nothing for them. If the other platform's build
  failed, its files are already gone and `platforms=built` publishes what finished.
- **Beta or nightly:** build one platform only:
  `gh workflow run release.yml --ref dev -f channel=beta -f platforms=mac` (or `windows`).

## Betas and nightlies

- Beta: `gh workflow run release.yml --ref dev -f channel=beta`, or Actions → Release → Run
  workflow. It numbers itself (`x.y.z-beta.N`) and builds both platforms unless you pass
  `-f platforms=mac` or `windows`.
- Nightly: runs on its own every night when `dev` changed; start one by hand with
  `-f channel=nightly`. Only the newest 7 are kept.

## When something fails

- **One platform's build failed, timed out or was cancelled.** Its files come out of the draft:
  the build removes them when it can, and publishing drops any platform without its feed file. A beta or nightly
  has gone out for the other platform; the failed one catches up with the next build. For
  stable, either publish what finished (`platforms=built`) or re-run the whole workflow.
- **A build failed and you want it again.** Re-run the whole workflow, not only the failed job:
  a re-run gets the same version, even a nightly re-run after midnight (its date is the run's
  start), deletes the draft the failed run left and builds again. A published release is never
  replaced.
- **A feed check failed.** That platform's build failed, so the line above applies. Read the
  step's output: it names the platform and the reason (missing entry, another platform's entry,
  wrong key, wrong version). Fix the cause, then re-run.
- **A publish failed.** Re-run it, or run **Publish** with the tag (on `dev` for a beta or
  nightly, on `main` for stable). It is safe to run again: once a release is published it skips
  that step and finishes the rest (the feed, old nightlies, the Homebrew tap). Feeds and the
  tap only move forward: publishing an older release again leaves a newer one in place.
- **The Homebrew step warned or failed.** The release is out; only the tap is behind. Fix the
  token or the tap, then run **Publish** on `main` with the tag again.

## Test the update loop on a Mac

Test an update before it reaches any feed, against one served on your Mac. The `local-feed` cargo feature lets a build read `KRIYON_UPDATE_FEED`; never turn it on in
CI. Give the test builds their own app id and run them with their own `HOME`, so they never
touch your installed Kriyon, its sessions or `~/.claude/settings.json`.

1. Write a config overlay, `local.conf.json`, with the test key's public half (the contents of
   `~/.tauri/kriyon-updater-test.key.pub`), so the real private key never leaves its backups:
   `{"identifier": "com.leafycode.kriyon.updatetest", "productName": "KriyonUpdateTest",
   "plugins": {"updater": {"pubkey": "<test public key>",
   "dangerousInsecureTransportProtocol": true}}}`
2. Build an old and a new version, keeping each `target/release/bundle/macos/` before the next
   build overwrites it:

   ```sh
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/kriyon-updater-test.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
   pnpm tauri build --features local-feed --bundles app \
     --config src-tauri/tauri.updater.conf.json --config local.conf.json \
     --config '{"version":"0.12.1"}'
   ```

   Check the new `.sig`: `base64 -d < KriyonUpdateTest.app.tar.gz.sig` must show
   `version:0.12.1` in its trusted comment, or the app refuses it.
3. In a folder with the new `KriyonUpdateTest.app.tar.gz`, write `darwin.json` with `version`,
   `notes` and, under `platforms`, `darwin-aarch64-app` and `darwin-aarch64` (`x86_64` on
   Intel), each with the `.sig` file's contents as `signature` and
   `http://127.0.0.1:8765/KriyonUpdateTest.app.tar.gz` as `url`. Serve it:
   `python3 -m http.server 8765 --bind 127.0.0.1`.
4. Copy the old app somewhere writable and start it:

   ```sh
   HOME=/tmp/kriyon-update-home KRIYON_UPDATE_FEED=http://127.0.0.1:8765/darwin.json \
     KriyonUpdateTest.app/Contents/MacOS/kriyon
   ```

   About 5 seconds in it fetches `darwin.json`. Pass the welcome screen, open the
   **Update available** pill, and choose **Install & restart**. The app downloads the file,
   restarts, and its `Info.plist` then says the new version.

To try a channel step-down, build the running version as a nightly
(`0.13.0-nightly.20261017.1`), serve a beta (`0.13.0-beta.1`), and pick Beta in Settings.

## One-time setup

Secrets live in two environments: `prerelease` (deploys from `dev` only, no approval) and
`release` (deploys from `main` only, waits for a maintainer). Both hold the names below;
`release` also needs `HOMEBREW_TAP_TOKEN`. Use the values that `.env.example` describes for a
local `pnpm release:mac`. The repo went public from one fresh commit (ADR 0048); the private
history, its trial releases and its repo secrets stay on `LeafyCode/kriyon-private`.

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | The Developer ID Application certificate and its key, exported from Keychain Access as `.p12`, then `base64 -i cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The password you gave that `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Company Name (TEAMID1234)` |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |
| `APPLE_API_KEY` | App Store Connect API key ID (10 characters) |
| `APPLE_API_KEY_BASE64` | The `AuthKey_<id>.p8` file, `base64 -i AuthKey_<id>.p8` |
| `TAURI_SIGNING_PRIVATE_KEY` | The update key's private half (the file's contents) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password |
| `HOMEBREW_TAP_TOKEN` | Fine-grained token with Contents read and write on `LeafyCode/homebrew-tap` only |

**The update key.** Every update file is signed with it, and installed apps trust only its
public half, in `src-tauri/tauri.updater.conf.json` (`plugins.updater.pubkey`; not secret).

- *The real key.* Made with `pnpm tauri signer generate -w ~/.tauri/kriyon-updater.key`, with
  a password, when the repo went public. Its private half and password are the two
  `TAURI_SIGNING_…` secrets in both environments. **They are backed up in two safe places**
  (the team password manager and an offline copy). If they're lost, installed apps can never
  update again.
- *The test key.* The private repo tried the pipeline with a throwaway key with no password
  (`~/.tauri/kriyon-updater-test.key`, id `BD4E5D6CC630A741`). It is never backed up and never
  ships to users: both workflows refuse it in a public repo (`scripts/publish.mjs check-key`),
  so leave `TEST_KEY_ID` in `scripts/publish-lib.mjs` as it is. The local update loop below
  still uses it.

**The tap.** A public repo `LeafyCode/homebrew-tap` with a `Casks/` folder. Publishing a stable
release writes `Casks/kriyon.rb`; users install with `brew install leafycode/tap/kriyon`.

## If a key leaks

Act first, then write down what happened.

- **Tauri update key.** This is the dangerous one: with it, anyone who can also serve a feed can
  ship an update every installed app accepts. Today the feed is this repo's releases, so also
  check who has write access and rotate any token that could publish. Make a new key, put its
  public half in `tauri.updater.conf.json`, and ship a release **signed with the old key** so
  installed apps accept it and learn the new key. Then replace the secret and destroy the old
  key everywhere it was backed up. Say what happened in the release notes.
- **Developer ID certificate.** Revoke it at developer.apple.com (Certificates), make a new
  one, and replace `APPLE_CERTIFICATE`, its password and `APPLE_SIGNING_IDENTITY`. Revoking
  can stop Macs opening apps signed with the old certificate: ship a newly signed release the
  same day.
- **App Store Connect API key.** Revoke it in App Store Connect (Users and Access →
  Integrations), make a new one, and replace `APPLE_API_KEY`, `APPLE_API_KEY_BASE64` and, if
  it changed, `APPLE_API_ISSUER`.
- **Homebrew tap token.** Revoke it in GitHub settings, check the tap's recent commits, and add
  a new one.
