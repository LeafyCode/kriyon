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

# No release yet (the build failed before uploading): nothing to remove.
if ! draft="$(gh release view "$tag" --json isDraft --jq .isDraft 2>/dev/null)"; then
  echo "  ✓ $tag has no release yet; nothing to remove" >&2
  exit 0
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
