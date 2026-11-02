#!/usr/bin/env bash
# Remove one platform's files from a draft release (ADR 0056): a build that
# failed takes its half-uploaded files back out, and a release published for
# one platform only drops the other's. Which file belongs to which platform is
# `assetPlatform` in scripts/publish-lib.mjs. Refuses a published release:
# downloads never change once out.
#
# Needs gh with GH_TOKEN (contents: write).
#
# Usage: scripts/drop-platform.sh <tag> <darwin|windows>
set -euo pipefail

if (( $# != 2 )); then
  echo "usage: $0 <tag> <darwin|windows>" >&2
  exit 2
fi
tag="$1"
platform="$2"
errors="$(mktemp)"
trap 'rm -f "$errors"' EXIT

# No release at all: nothing to remove. Any other gh failure (network, rate
# limit, auth) stops here, so files are never left behind unnoticed.
if ! draft="$(gh release view "$tag" --json isDraft --jq .isDraft 2>"$errors")"; then
  if grep -q "release not found" "$errors"; then
    echo "  ✓ $tag has no release; nothing to remove" >&2
    exit 0
  fi
  cat "$errors" >&2
  echo "✗ Couldn't read $tag, so its $platform files may still be in the draft." >&2
  exit 1
fi
if [[ "$draft" != true ]]; then
  echo "✗ $tag is already published; its files stay as they are." >&2
  exit 1
fi

gh release view "$tag" --json assets --jq '.assets[].name' \
  | xargs node scripts/publish.mjs platform-assets "$platform" \
  | while read -r name; do
      gh release delete-asset "$tag" "$name" --yes
      echo "  ✓ Removed $name from $tag" >&2
    done
