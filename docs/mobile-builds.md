# Phone builds (EAS)

How the phone app is built for the App Store and Google Play. The repo is ready for it: the
build profiles (`mobile/app/eas.json`), the hooks that build the Rust library on EAS's servers
(`scripts/mobile/eas-build.mjs`) and the workflow (`.github/workflows/eas.yml`). What needs a
person is the accounts: Expo, Apple and Google. Nothing below goes into the repo except the
project id `eas init` writes into `mobile/app/app.json`.

**Never commit credentials**: no signing keys, keystores, `credentials.json`, App Store Connect
keys, Google service account files or `google-services.json`. EAS keeps them; the repo ignores
their usual names as a safety net.

## Profiles

| Profile | What it makes | For |
|---|---|---|
| `development` | A development build (dev client), installable on your devices | Working on the app with Metro |
| `preview` | A release build shared by link (`.apk` on Android, ad hoc on iPhone) | Trying a build on real phones before a release |
| `production` | Store builds (`.aab`, App Store `.ipa`); the build number goes up by one each time | The stores |

The app's version is the release's (`pnpm release` sets it in `mobile/app/app.json`); the
stores get its plain `x.y.z` (a pre-release's suffix is dropped). Build numbers and version
codes are kept by EAS (`appVersionSource: remote`).

## Set up once

1. **The Expo project.** Make an Expo account (an organisation for the company is best). Then,
   in the repo: `cd mobile/app && npx eas-cli@27.2.0 login && npx eas-cli@27.2.0 init`. It
   creates the project and writes its id and owner into `app.json`; commit that change.
2. **The token for GitHub.** On expo.dev: the organisation → Access tokens → make a robot
   user with a token that can build. In the GitHub repo: Settings → Secrets and variables →
   Actions → new secret `EXPO_TOKEN`. Until it exists, the Phone builds workflow skips itself.
3. **The build's settings.** On expo.dev: the project → Environment variables, for the
   `preview` and `production` environments (and `development` if you want them there):
   - `KRIYON_PUSH_URL`: the push sender's address. Without it, alerts are off.
   - `KRIYON_RELAY_API`: our relay's address. Without it, the phone has no relay section.
   - `GOOGLE_SERVICES_JSON`: a **file** variable holding Firebase's `google-services.json`,
     visibility secret. Without it, Android alerts say they need a Firebase setup.

   These are build-time addresses, not secrets, but they stay out of the repo.
4. **iPhone credentials.** An Apple Developer account. Run
   `npx eas-cli@27.2.0 credentials -p ios` (or let the first iOS build ask): EAS makes and keeps
   the distribution certificate and provisioning profile. For push, make an APNs key in the
   Apple Developer site; it goes to the push sender's own settings, not to EAS or the repo.
   For uploads, make the app in App Store Connect with the bundle id
   `com.leafycode.kriyon.mobile`, and give EAS an App Store Connect API key when
   `eas submit` asks.
5. **Android credentials.** Let the first Android build make the upload keystore (EAS keeps
   it). Make the app in the Google Play Console with the package `com.leafycode.kriyon.mobile`
   and upload the first `.aab` by hand (Google's rule). For later uploads, give EAS a Google
   service account key when `eas submit` asks. Firebase's service account key for push goes to
   the push sender's own settings.

## When builds run

- **A push to `main` that touches the phone app or its crates** (a stable release): production
  builds for both phones start on EAS. The workflow returns once they have started; progress
  and the files are on expo.dev.
- **By hand**: Actions → Phone builds (EAS) → Run workflow, with a profile and the phones.
  Production builds start only from `main`, so a store build number always belongs to
  released code; preview and development builds start from any branch.
- Never on every change to `dev`, to stay inside the monthly limit.
- Uploading to the stores is a separate step: `npx eas-cli@27.2.0 submit -p ios|android
  --latest` from `mobile/app`, until store review is routine enough to add `--auto-submit`.

Each build runs the hooks in `mobile/app/package.json`. Before installing packages, the Rust
library is built for that phone: EAS's servers have no Rust, so a minimal toolchain of the
pinned version (`RUST_VERSION` in `scripts/mobile/eas-build.mjs`) is installed first, and the
iPhone library is built for phones only (no Simulator slice). After installing, the terminal
page is made. Android builds use NDK 27.1, the one React Native 0.88 asks for (`eas.json`; a
test keeps it equal to the hook's). The Rust build adds several minutes to each build.

## The monthly limit

EAS's free plan includes a set number of builds each month; each phone is one build, so a
release costs two. When the month's builds run out, the options are a paid plan, or local
builds: `npx eas-cli@27.2.0 build --local` on a Mac with Xcode and the Android SDK, or the same
on GitHub's macOS runners (ten times the cost of Linux minutes on a private repo). See
expo.dev/pricing for the current numbers.
