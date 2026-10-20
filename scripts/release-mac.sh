#!/usr/bin/env bash
# Build a signed + notarized + stapled macOS release of Kriyon.
#
# Signing identity and notarization credentials all come from .env (see .env.example);
# the cert named by APPLE_SIGNING_IDENTITY must be present in your login keychain.
# Tauri signs the app; scripts/notarize-dmg.sh then notarizes and staples the
# DMG, whose ticket covers the app inside.
#
# Builds a universal (Apple Silicon + Intel) binary by default. Override the
# arch with KRIYON_BUILD_TARGET (e.g. aarch64-apple-darwin for Apple-Silicon only).
#
# Usage: pnpm release:mac  [-- extra `tauri build` args, e.g. --bundles dmg]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="$REPO_ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# Load .env (ignoring comments/blank lines) into the environment.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

missing=()
for var in APPLE_SIGNING_IDENTITY APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
if (( ${#missing[@]} > 0 )); then
  echo "error: missing required env vars in .env: ${missing[*]}" >&2
  exit 1
fi

if [[ ! -f "$APPLE_API_KEY_PATH" ]]; then
  echo "error: APPLE_API_KEY_PATH does not point to a file: $APPLE_API_KEY_PATH" >&2
  exit 1
fi

# Default to a universal binary so the DMG runs on both Apple Silicon and Intel.
BUILD_TARGET="${KRIYON_BUILD_TARGET:-universal-apple-darwin}"

# The main app and the ptyd sidecar must both cover every arch in BUILD_TARGET,
# so make sure the needed rustup targets are installed.
if [[ "$BUILD_TARGET" == "universal-apple-darwin" ]]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
else
  rustup target add "$BUILD_TARGET"
fi

# Tell scripts/sidecar-ptyd.mjs (run by tauri's beforeBuildCommand) which arch(es)
# to build kriyon-ptyd for, so its sidecar name matches the app's --target.
export KRIYON_SIDECAR_TARGET="$BUILD_TARGET"

# The release profile uses thin LTO (see Cargo.toml [profile.release]) for a
# ~46%-smaller binary. The trade-off is a memory-hungry optimize/link step: on a
# low-memory machine the parallel build can run out of memory. Set
# KRIYON_CARGO_JOBS (e.g. KRIYON_CARGO_JOBS=2) to cap parallelism. It maps to
# CARGO_BUILD_JOBS, which both the app build and the ptyd sidecar (spawned in
# this same environment) honor. Unset ⇒ cargo uses all cores (full speed).
if [[ -n "${KRIYON_CARGO_JOBS:-}" ]]; then
  export CARGO_BUILD_JOBS="$KRIYON_CARGO_JOBS"
  echo "==> Capping cargo build jobs at $CARGO_BUILD_JOBS"
fi

BUNDLE="target/$BUILD_TARGET/release/bundle"
# A DMG left from an earlier build must not be taken for this one.
rm -rf "$BUNDLE/dmg"

echo "==> Building signed + notarized macOS release ($BUILD_TARGET)…"
# Without the App Store Connect key Tauri signs but doesn't notarize: only the
# DMG is notarized, as Apple advises for the outermost container.
env -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH \
  pnpm tauri build --target "$BUILD_TARGET" "$@"

# The DMG is the only thing notarized, so a build without exactly one (for
# example `--bundles app`) is not a release.
shopt -s nullglob
dmgs=("$BUNDLE/dmg/"*.dmg)
shopt -u nullglob
if (( ${#dmgs[@]} != 1 )); then
  echo "error: expected one DMG to notarize, found ${#dmgs[@]}. Build the dmg bundle." >&2
  exit 1
fi
dmg="${dmgs[0]}"
scripts/notarize-dmg.sh "$dmg"

# The same check the release workflow runs: version, both chips, signatures,
# notarization. It wants both chips, so only a universal build is checked.
if [[ "$BUILD_TARGET" == "universal-apple-darwin" ]]; then
  echo "==> Checking the build"
  scripts/check-mac-bundle.sh "$BUNDLE/macos/Kriyon.app" "$dmg" \
    "$(node -p 'require("./package.json").version')"
fi

echo
echo "==> Done. Artifacts in $BUNDLE/ (.app in macos/, installer in dmg/)."
