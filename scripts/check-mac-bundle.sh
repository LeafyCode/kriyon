#!/usr/bin/env bash
# Check a release build of Kriyon before it is published: the app says the
# version being released, the app and its kriyon-ptyd helper both run on Apple
# Silicon and Intel and are signed with a Developer ID, and the app and the
# DMG are notarized, with the ticket stapled to the DMG. Run by
# .github/workflows/release.yml after the DMG is notarized; also works on a
# local `pnpm release:mac` build.
#
# Usage: scripts/check-mac-bundle.sh <Kriyon.app> <Kriyon.dmg> <version>
set -euo pipefail

if (( $# != 3 )); then
  echo "usage: $0 <Kriyon.app> <Kriyon.dmg> <version>" >&2
  exit 2
fi
app="$1"
dmg="$2"
version="$3"
failed=0

fail() {
  echo "✗ $*" >&2
  failed=1
}
ok() {
  echo "  ✓ $*" >&2
}

# The guard: the version inside the app is the one the release is named for.
shown="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
if [[ "$shown" == "$version" ]]; then
  ok "The app says $version"
else
  fail "The app says $shown, but this release is $version"
fi

for binary in "$app/Contents/MacOS/kriyon" "$app/Contents/MacOS/kriyon-ptyd"; do
  name="$(basename "$binary")"
  archs="$(lipo -archs "$binary")"
  if [[ " $archs " == *" arm64 "* && " $archs " == *" x86_64 "* ]]; then
    ok "$name runs on Apple Silicon and Intel ($archs)"
  else
    fail "$name is built for '$archs', not both arm64 and x86_64"
  fi
  if codesign --verify --strict "$binary" 2>/dev/null; then
    ok "$name is signed"
  else
    fail "$name is not validly signed"
  fi
done

details="$(codesign --display --verbose=2 "$app" 2>&1)"
if [[ "$details" == *"Authority=Developer ID Application:"* ]]; then
  ok "The app is signed with a Developer ID"
else
  fail "The app is not signed with a Developer ID Application certificate"
fi
if [[ "$details" == *"(runtime)"* ]]; then
  ok "The app uses the hardened runtime"
else
  fail "The app does not use the hardened runtime, which notarization needs"
fi
if codesign --verify --deep --strict "$app" 2>/dev/null; then
  ok "Everything inside the app is signed"
else
  fail "Something inside the app is not validly signed"
fi

# Gatekeeper's own verdict, as a user's Mac gives it on first open. The DMG's
# notarization covers the app inside it (scripts/notarize-dmg.sh).
verdict="$(spctl --assess --type execute -vv "$app" 2>&1 || true)"
if [[ "$verdict" == *": accepted"* && "$verdict" == *"source=Notarized Developer ID"* ]]; then
  ok "Gatekeeper accepts the app as notarized"
else
  fail "Gatekeeper does not accept the app as notarized: $verdict"
fi
verdict="$(spctl --assess --type open --context context:primary-signature -vv "$dmg" 2>&1 || true)"
if [[ "$verdict" == *": accepted"* && "$verdict" == *"source=Notarized Developer ID"* ]]; then
  ok "Gatekeeper accepts the DMG as notarized"
else
  fail "Gatekeeper does not accept the DMG as notarized: $verdict"
fi
if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
  ok "The DMG has its notarization ticket stapled"
else
  fail "The DMG has no stapled notarization ticket"
fi

exit "$failed"
