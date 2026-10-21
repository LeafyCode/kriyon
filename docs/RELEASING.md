# Releasing Kriyon

How a build gets from `dev` to people's Macs. Why it works this way is in ADR 0045 (versions
and the changelog) and ADR 0046 (builds, publishing and feeds).

| Channel | Built from | When | Who publishes |
|---|---|---|---|
| Stable `0.13.0` | `main` | The release PR is merged | A person, with the Publish workflow |
| Beta `0.13.0-beta.1` | `dev` | Someone runs the Release workflow, channel beta | The workflow, once its checks pass |
| Nightly `0.13.0-nightly.20261016.41` | `dev` | Every night at 03:17 UTC, if `dev` changed | The workflow, once its checks pass |

Every build is a universal (Apple Silicon and Intel) Mac app, signed with the Developer ID,
notarized, and checked by `scripts/check-mac-bundle.sh`. It lands as a draft release with its
DMG, the signed update file (`Kriyon.app.tar.gz` and its `.sig`) and `latest.json`. Nothing
reaches anyone until the draft is published, and publishing first checks `latest.json` again.

The DMG is uploaded twice: once with its version in the name (`Kriyon_0.13.0_universal.dmg`,
which the Homebrew cask uses) and once as `Kriyon.dmg`. The website's download button links to
`https://github.com/LeafyCode/kriyon/releases/latest/download/Kriyon.dmg`, which always serves
the newest stable release.

Update feeds, which the in-app updater reads (ADR 0047):

- Stable: `https://github.com/LeafyCode/kriyon/releases/latest/download/latest.json`
- Beta: `https://github.com/LeafyCode/kriyon/releases/download/feed-beta/latest.json`
  (a stable release goes here too, so beta users land on it)
- Nightly: `https://github.com/LeafyCode/kriyon/releases/download/feed-nightly/latest.json`

## Ship a stable release

1. Cut it with the `release` skill or by hand: `pnpm release` from an up-to-date `dev`, PR
   into `dev`, then the release PR from `dev` into `main`.
2. The merge starts **Release**. It refuses if `main` took a user-facing change the
   changelog entry doesn't list: add it to the entry in a `chore(release): <version>` PR into
   `dev`, then take `dev` into `main` again. Otherwise it leaves a draft `v<version>`.
3. Check the draft on GitHub: notes, files, and if you like, install the DMG. You can edit the
   notes there. The in-app update dialog shows the notes from `latest.json`, which came from
   `CHANGELOG.md`, so fix big mistakes in the changelog, not only on the draft. To change the
   version, delete the draft and cut again: the version is built into the app.
4. Run **Publish** on `main` with the tag:
   `gh workflow run publish.yml --ref main -f tag=v0.13.0`. It checks the feed, publishes
   (GitHub makes the tag), puts the release on the beta feed and bumps the Homebrew tap.

## Betas and nightlies

- Beta: `gh workflow run release.yml --ref dev -f channel=beta`, or Actions → Release → Run
  workflow. It numbers itself (`x.y.z-beta.N`).
- Nightly: runs on its own every night when `dev` changed; start one by hand with
  `-f channel=nightly`. Only the newest 7 are kept.

## When something fails

- **A build failed.** Re-run it. A re-run gets the same version, even a nightly re-run after
  midnight (its date is the run's start), deletes the draft the failed run left and builds
  again. A published release is never replaced.
- **The feed check failed.** Nothing was published and no feed moved. Read the step's output:
  it names the platform and the reason (missing entry, wrong key, wrong version). Fix the cause,
  then re-run.
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
3. In a folder with the new `KriyonUpdateTest.app.tar.gz`, write `latest.json` with `version`,
   `notes` and, under `platforms`, `darwin-aarch64-app` and `darwin-aarch64` (`x86_64` on
   Intel), each with the `.sig` file's contents as `signature` and
   `http://127.0.0.1:8765/KriyonUpdateTest.app.tar.gz` as `url`. Serve it:
   `python3 -m http.server 8765 --bind 127.0.0.1`.
4. Copy the old app somewhere writable and start it:

   ```sh
   HOME=/tmp/kriyon-update-home KRIYON_UPDATE_FEED=http://127.0.0.1:8765/latest.json \
     KriyonUpdateTest.app/Contents/MacOS/kriyon
   ```

   About 5 seconds in it fetches `latest.json`. Pass the welcome screen, open the
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
