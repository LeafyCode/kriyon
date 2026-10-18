#!/usr/bin/env bash
# Notarize and staple a Kriyon DMG. Apple's guidance is to notarize and staple
# only the outermost container: the DMG's ticket covers the app inside, and
# macOS takes it in when the DMG is opened, so the app needs no ticket of its
# own. Tauri therefore only signs the app (its own staple is never checked,
# and fails when it runs before Apple has published the ticket). Used by
# scripts/release-mac.sh and .github/workflows/release.yml.
#
# Needs the App Store Connect API key: APPLE_API_KEY_PATH (the .p8 file),
# APPLE_API_KEY (its id) and APPLE_API_ISSUER.
#
# Usage: scripts/notarize-dmg.sh <Kriyon.dmg>
set -euo pipefail

if (( $# != 1 )); then
  echo "usage: $0 <Kriyon.dmg>" >&2
  exit 2
fi

echo "==> Notarizing DMG: $1"
xcrun notarytool submit "$1" \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait

# The ticket can take a few minutes to reach Apple's servers after
# notarization is accepted; until then stapling fails with "Record not found".
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if xcrun stapler staple "$1"; then
    exit 0
  fi
  echo "    The ticket isn't ready yet (try $attempt of 10); waiting 30 seconds" >&2
  sleep 30
done
echo "error: could not staple the ticket to $1" >&2
exit 1
