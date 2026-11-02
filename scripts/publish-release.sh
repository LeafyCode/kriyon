#!/usr/bin/env bash
# Publish a draft release and move its channel's update feeds. Run by
# .github/workflows/release.yml (betas and nightlies, straight after the
# build) and publish.yml (stable, when a person runs it). See ADR 0046 and
# ADR 0056.
#
#   1. Find which platforms the release was built for: each build job uploads
#      its feed file (darwin.json, windows.json) only once all its checks
#      passed, so a file in the draft means that platform is ready. A release
#      needs at least one. Given a platform, the draft is published for that
#      one only: the other's files are taken out first
#      (scripts/drop-platform.sh), so its users are not offered this version.
#   2. Check each of those feed files (scripts/publish.mjs check-feed), and
#      the Mac's latest.json, the feed builds up to 0.15.0 read. Nothing below
#      runs unless they pass, so no feed ever names a bad file.
#   3. Publish the draft. GitHub makes the tag now, on the draft's commit.
#      Stable becomes GitHub's "latest release" only when it has a Mac build
#      and is the newest stable: older Mac builds read
#      releases/latest/download/latest.json, and the website links to
#      releases/latest/download/Kriyon.dmg, so a Windows-only release must
#      not take that over.
#   4. Move each built platform's feed file on the channel's fixed
#      pre-release (feed-stable, feed-beta, feed-nightly), plus the Mac's
#      latest.json on feed-beta and feed-nightly for older builds. Stable is
#      put on the beta feeds too, so beta users land on it. A Windows build
#      also puts its installer on its feed releases as Kriyon-setup.exe, a
#      fixed name: the website links to feed-beta's while Windows is in beta,
#      and to feed-stable's once it ships stable.
#   5. Fill in any feed file still missing on any channel, so no build ever
#      reads a file that isn't there (a failed check). The Mac's comes from
#      that channel's latest.json, so it names the Mac's real current
#      version; the first run seeds feed-stable/darwin.json with 0.15.0.
#      Windows, until its first build reaches the channel, gets the same
#      version with no entries, which the app reads as no update. A later
#      build replaces a seed like any older feed file.
#   6. Keep only the newest nightlies.
#   7. From the fourth stable release after 0.15.0, warn that latest.json
#      (step 4's legacy feed) can probably go (ADR 0056).
#
# Safe to run again: a release already published skips step 3, so a run that
# failed after publishing can still finish moving the feeds. A feed only moves
# forward: an older release never replaces the version a feed file names.
#
# Needs gh with GH_TOKEN (contents: write).
#
# Usage: scripts/publish-release.sh <tag> [darwin|windows]
set -euo pipefail

if (( $# < 1 || $# > 2 )); then
  echo "usage: $0 <tag> [darwin|windows]" >&2
  exit 2
fi
tag="$1"
only="${2:-}"
case "$only" in
  "" | darwin | windows) ;;
  *)
    echo "✗ \"$only\" is not darwin or windows" >&2
    exit 2
    ;;
esac
version="${tag#v}"
channel="$(node scripts/publish.mjs channel "$tag")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Fails here when there is no release for the tag at all.
draft="$(gh release view "$tag" --json isDraft --jq .isDraft)"
if [[ -n "$only" && "$draft" == true ]]; then
  for other in darwin windows; do
    if [[ "$other" != "$only" ]]; then
      scripts/drop-platform.sh "$tag" "$other"
    fi
  done
fi
assets="$(gh release view "$tag" --json assets --jq '.assets[].name')"

platforms=()
for platform in darwin windows; do
  if [[ -n "$only" && "$platform" != "$only" ]]; then
    continue
  fi
  if grep -qx "$platform.json" <<<"$assets"; then
    platforms+=("$platform")
  fi
done
if (( ${#platforms[@]} == 0 )); then
  echo "✗ $tag has no platform's feed file (darwin.json or windows.json): no build finished." >&2
  exit 1
fi
has() { [[ " ${platforms[*]} " == *" $1 "* ]]; }

for platform in "${platforms[@]}"; do
  gh release download "$tag" --pattern "$platform.json" --dir "$work"
  node scripts/publish.mjs check-feed "$work/$platform.json" --version "$version"
done
if has darwin; then
  gh release download "$tag" --pattern latest.json --dir "$work"
  node scripts/publish.mjs check-feed "$work/latest.json" --version "$version"
fi
echo "  ✓ $tag is built for: ${platforms[*]}" >&2

if [[ "$draft" != "true" ]]; then
  echo "  ✓ $tag is already published; finishing the rest" >&2
elif [[ "$channel" == "stable" ]]; then
  newest=false
  if has darwin; then
    stable="$(gh release list --limit 200 --exclude-drafts --exclude-pre-releases \
      --json tagName --jq '.[].tagName')"
    # shellcheck disable=SC2086 # one tag per word
    newest="$(node scripts/publish.mjs moves-forward "$tag" $stable)"
  fi
  gh release edit "$tag" --draft=false --latest="$newest"
  if [[ "$newest" == true ]]; then
    echo "  ✓ Published $tag as the latest release" >&2
  else
    echo "  ✓ Published $tag; the latest release stays on the newest Mac build" >&2
  fi
else
  gh release edit "$tag" --draft=false --prerelease --latest=false
  echo "  ✓ Published $tag" >&2
fi

# Make the feed-<feed> pre-release if there is none yet.
ensure_feed_release() {
  if ! gh release view "feed-$1" >/dev/null 2>&1; then
    gh release create "feed-$1" --prerelease --latest=false \
      --target "$(git rev-parse HEAD)" \
      --title "Kriyon $1 update feed" \
      --notes "Holds only the $1 channel's update feeds, one file per platform. Downloads are on each version's own release." >&2
  fi
}

# Put $work/<file> on the feed-<feed> pre-release, unless the copy there names
# a newer version. Prints true when it moved.
move_feed() {
  local feed="feed-$1" file="$2"
  ensure_feed_release "$1"
  # A new feed release has no files yet; any other failure stops here.
  local current_assets
  current_assets="$(gh release view "$feed" --json assets --jq '.assets[].name')"
  if grep -qx "$file" <<<"$current_assets"; then
    gh release download "$feed" --pattern "$file" --output "$work/current-$file" --clobber
    local current forward
    current="$(jq -er .version "$work/current-$file")"
    forward="$(node scripts/publish.mjs moves-forward "$version" "$current")"
    if [[ "$forward" != true ]]; then
      echo "  ✓ $feed/$file already names a newer version; left as it is" >&2
      echo false
      return
    fi
  fi
  gh release upload "$feed" "$work/$file" --clobber >&2
  echo "  ✓ $feed/$file names $version" >&2
  echo true
}

# The feed releases this channel's builds go on: stable lands on beta too.
case "$channel" in
  stable) feeds=(stable beta) ;;
  beta) feeds=(beta) ;;
  nightly) feeds=(nightly) ;;
esac

for feed in "${feeds[@]}"; do
  for platform in "${platforms[@]}"; do
    moved="$(move_feed "$feed" "$platform.json")"
    if [[ "$platform" == windows && "$moved" == true ]]; then
      gh release download "$tag" --pattern 'Kriyon_*_x64-setup.exe' --dir "$work/setup" --clobber
      setups=("$work"/setup/*.exe)
      if (( ${#setups[@]} != 1 )); then
        echo "✗ Expected one setup.exe on $tag, found: ${setups[*]}" >&2
        exit 1
      fi
      cp "${setups[0]}" "$work/Kriyon-setup.exe"
      gh release upload "feed-$feed" "$work/Kriyon-setup.exe" --clobber
      echo "  ✓ feed-$feed/Kriyon-setup.exe is $version's installer" >&2
    fi
  done
  # Builds up to 0.15.0 read latest.json. Stable's is the latest release's,
  # moved above; the others live on their feed release.
  if [[ "$feed" != stable ]] && has darwin; then
    move_feed "$feed" latest.json >/dev/null
  fi
done

# Fill in each channel's missing feed files from the Mac's latest.json there:
# stable's is the latest release's, the others' are on their feed release.
for feed in stable beta nightly; do
  ensure_feed_release "$feed"
  present="$(gh release view "feed-$feed" --json assets --jq '.assets[].name')"
  missing=()
  for platform in darwin windows; do
    if ! grep -qx "$platform.json" <<<"$present"; then
      missing+=("$platform")
    fi
  done
  if (( ${#missing[@]} == 0 )); then
    continue
  fi
  seeds="$work/seed-$feed"
  mkdir -p "$seeds"
  # No tag downloads from GitHub's latest release.
  from=()
  if [[ "$feed" != stable ]]; then
    from=("feed-$feed")
  fi
  if ! gh release download ${from[@]+"${from[@]}"} --pattern latest.json --dir "$seeds" --clobber; then
    echo "::warning::feed-$feed has no latest.json to seed ${missing[*]} from; left missing." >&2
    continue
  fi
  for platform in "${missing[@]}"; do
    node scripts/publish.mjs platform-feed "$seeds/latest.json" --platform "$platform" \
      >"$seeds/$platform.json"
    gh release upload "feed-$feed" "$seeds/$platform.json" >&2
    echo "  ✓ Seeded feed-$feed/$platform.json from its latest.json" >&2
  done
done

if [[ "$channel" == nightly ]]; then
  gh release list --limit 200 --exclude-drafts --json tagName --jq '.[].tagName' \
    | xargs node scripts/publish.mjs stale-nightlies \
    | while read -r old; do
        gh release delete "$old" --cleanup-tag --yes
        echo "  ✓ Deleted the old nightly $old" >&2
      done
fi

# latest.json only serves builds up to 0.15.0. Once four stable releases have
# followed it, nag in the run summary to check whether it can go (ADR 0056).
if [[ "$channel" == stable ]]; then
  after=0
  for t in $(gh release list --limit 200 --exclude-drafts --exclude-pre-releases \
    --json tagName --jq '.[].tagName'); do
    v="${t#v}"
    if [[ "$v" != 0.15.0 && "$(printf '%s\n' 0.15.0 "$v" | sort -V | tail -n1)" == "$v" ]]; then
      after=$((after + 1))
    fi
  done
  if (( after >= 4 )); then
    echo "::warning::$after stable releases since 0.15.0: time to check whether latest.json (the feed for 0.15.0 and older) can be dropped. See ADR 0056." >&2
  fi
fi
