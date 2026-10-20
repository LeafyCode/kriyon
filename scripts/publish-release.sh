#!/usr/bin/env bash
# Publish a draft release and move its channel's update feed. Run by
# .github/workflows/release.yml (betas and nightlies, straight after the
# build) and publish.yml (stable, when a person runs it). See ADR 0046.
#
#   1. Check the draft's latest.json (scripts/publish.mjs check-feed). Nothing
#      below runs unless it passes, so no feed ever names a bad file.
#   2. Publish the draft. GitHub makes the tag now, on the draft's commit.
#   3. Move the feed. Stable's feed is GitHub's "latest release" link, which
#      moved in step 2; betas and nightlies each have one fixed pre-release
#      (feed-beta, feed-nightly) that holds only their latest.json. Stable is
#      put on the beta feed too, so beta users land on it.
#   4. Keep only the newest nightlies.
#
# Safe to run again: a release already published skips step 2, so a run that
# failed after publishing can still finish moving the feed. A feed only moves
# forward: an older release never replaces the version a feed names.
#
# Needs gh with GH_TOKEN (contents: write).
#
# Usage: scripts/publish-release.sh <tag>
set -euo pipefail

if (( $# != 1 )); then
  echo "usage: $0 <tag>" >&2
  exit 2
fi
tag="$1"
version="${tag#v}"
channel="$(node scripts/publish.mjs channel "$tag")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Fails here when there is no release for the tag at all.
draft="$(gh release view "$tag" --json isDraft --jq .isDraft)"

gh release download "$tag" --pattern latest.json --dir "$work"
node scripts/publish.mjs check-feed "$work/latest.json" --version "$version"

if [[ "$draft" != "true" ]]; then
  echo "  ✓ $tag is already published; finishing the rest" >&2
elif [[ "$channel" == "stable" ]]; then
  # GitHub's latest release is the stable feed, and publish.yml bumps the tap
  # only for it, so it moves only when this is the newest stable release.
  stable="$(gh release list --limit 200 --exclude-drafts --exclude-pre-releases \
    --json tagName --jq '.[].tagName')"
  # shellcheck disable=SC2086 # one tag per word
  newest="$(node scripts/publish.mjs moves-forward "$tag" $stable)"
  gh release edit "$tag" --draft=false --latest="$newest"
  if [[ "$newest" == true ]]; then
    echo "  ✓ Published $tag as the latest release" >&2
  else
    echo "  ✓ Published $tag; a newer stable release stays the latest" >&2
  fi
else
  gh release edit "$tag" --draft=false --prerelease --latest=false
  echo "  ✓ Published $tag" >&2
fi

move_feed() {
  local feed="feed-$1"
  if ! gh release view "$feed" >/dev/null 2>&1; then
    gh release create "$feed" --prerelease --latest=false \
      --target "$(git rev-parse HEAD)" \
      --title "Kriyon $1 update feed" \
      --notes "Holds only latest.json, the $1 channel's update feed. Downloads are on each version's own release."
  fi
  # A new feed release has no latest.json yet; any other failure stops here.
  assets="$(gh release view "$feed" --json assets --jq '.assets[].name')"
  if grep -qx latest.json <<<"$assets"; then
    gh release download "$feed" --pattern latest.json --output "$work/current.json"
    current="$(jq -er .version "$work/current.json")"
    forward="$(node scripts/publish.mjs moves-forward "$version" "$current")"
    if [[ "$forward" != true ]]; then
      echo "  ✓ The $1 feed already names a newer version; left as it is" >&2
      return
    fi
  fi
  gh release upload "$feed" "$work/latest.json" --clobber
  echo "  ✓ The $1 feed names $version" >&2
}

case "$channel" in
  stable) move_feed beta ;;
  beta) move_feed beta ;;
  nightly)
    move_feed nightly
    gh release list --limit 200 --exclude-drafts --json tagName --jq '.[].tagName' \
      | xargs node scripts/publish.mjs stale-nightlies \
      | while read -r old; do
          gh release delete "$old" --cleanup-tag --yes
          echo "  ✓ Deleted the old nightly $old" >&2
        done
    ;;
esac
