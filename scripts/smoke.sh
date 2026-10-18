#!/usr/bin/env bash
# Build and launch an isolated "smoke" bundle of Kriyon for real-app QA.
#
# Smoke builds use a distinct bundle identifier (src-tauri/tauri.smoke.conf.json),
# so they get their own SQLite DB + webview data and never touch the production
# Kriyon you may be running from /Applications.
#
# Usage:
#   pnpm smoke              # build, then launch
#   pnpm smoke --no-build   # relaunch the existing bundle
#   pnpm smoke --sign       # re-sign with the Developer ID from .env before launching
#                           # (required for notifications: an ad-hoc signature is
#                           #  rejected by UNUserNotificationCenter, so banners
#                           #  are silently dropped)
#   pnpm smoke -- <extra tauri build args>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

APP="target/debug/bundle/macos/KriyonSmoke.app"
BIN="$APP/Contents/MacOS/kriyon"
BUILD=1
SIGN=0
# Note: macOS ships bash 3.2, where "${EXTRA[@]}" on an empty array trips `set -u`.
# Expand it as ${EXTRA[@]+"${EXTRA[@]}"} everywhere.
EXTRA=()

for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --sign) SIGN=1 ;;
    *) EXTRA+=("$arg") ;;
  esac
done

if (( BUILD )); then
  echo "==> Building smoke bundle (unsigned, isolated identifier)…"
  # Unset the Apple credentials so the build can never sign/notarize with them.
  env -u APPLE_SIGNING_IDENTITY -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH \
    pnpm tauri build --debug --bundles app \
      --config src-tauri/tauri.smoke.conf.json ${EXTRA[@]+"${EXTRA[@]}"}
fi

[[ -x "$BIN" ]] || { echo "error: $BIN not found — run without --no-build first." >&2; exit 1; }

if (( SIGN )); then
  [[ -f .env ]] || { echo "error: --sign needs .env with APPLE_SIGNING_IDENTITY." >&2; exit 1; }
  # shellcheck disable=SC1091
  IDENTITY="$(grep -E '^APPLE_SIGNING_IDENTITY=' .env | head -1 | cut -d= -f2-)"
  [[ -n "$IDENTITY" ]] || { echo "error: APPLE_SIGNING_IDENTITY missing from .env." >&2; exit 1; }
  echo "==> Re-signing smoke bundle as: $IDENTITY"
  codesign --force --options runtime --entitlements src-tauri/Entitlements.plist \
    --sign "$IDENTITY" --deep "$APP"
  codesign --verify --strict "$APP"
fi

# Kill only the smoke *app* binary. The path anchor keeps /Applications/Kriyon.app
# safe; the ($| ) anchor keeps the smoke kriyon-ptyd daemons alive across restarts.
pkill -9 -f "KriyonSmoke.app/Contents/MacOS/kriyon($| )" 2>/dev/null || true

LOG="/tmp/kriyon-smoke-$(date +%Y%m%d-%H%M%S).log"
nohup "$BIN" > "$LOG" 2>&1 < /dev/null & disown
echo "==> Launched KriyonSmoke (pid $!). Logs: $LOG"
