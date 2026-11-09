#!/usr/bin/env bash
# Writes the GitHub release notes for a version tag.
# Usage: release-notes.sh <tag, e.g. v1.0.0> <output file>
# Fails if the tag does not match the app version in pubspec.yaml.
set -euo pipefail

tag="$1"
out="$2"
app_dir="mobile/statusdrop_app"

# pubspec "version: 1.0.0+7" -> name 1.0.0, Android version code 7
pubspec_version="$(sed -n -E 's/^version:[[:space:]]*([^[:space:]]+).*/\1/p' "$app_dir/pubspec.yaml")"
version_name="${pubspec_version%%+*}"
version_code="${pubspec_version#*+}"
[ "$version_code" = "$pubspec_version" ] && version_code=""

if [ "$tag" != "v$version_name" ]; then
  echo "::error::Tag $tag does not match the app version v$version_name in $app_dir/pubspec.yaml"
  exit 1
fi

play_url="https://play.google.com/store/apps/details?id=com.wastatusvideo.statusdrop"

{
  echo "## Get it on Google Play"
  echo
  echo "[StatusDrop on Google Play]($play_url)"
  echo
  echo "Version $version_name${version_code:+ (version code $version_code)} · Android 10 or newer · ARM64 phones"
  echo
  echo "## What's in this version"
  echo
  # Drop the "StatusDrop x.y.z" title line and turn "•" bullets into Markdown.
  sed -e '1{/^StatusDrop /d;}' -e 's/^•[[:space:]]*/- /' "$app_dir/play/RELEASE_NOTES.txt" | sed -e '/./,$!d'
  echo
  echo "## StatusDrop MAX"
  echo
  echo "\`StatusDrop-MAX.apk\` below is StatusDrop MAX: the same app plus delivery from your own WhatsApp number (Message yourself, or a second number as your bot). It installs next to the Google Play version. Install steps and the risks of the self-host methods: https://wastatusvideo.com/max"
  echo
  echo "## Source code"
  echo
  echo "The source archives below match this release. The Android app is GPL-3.0 (it bundles FFmpegKit with x264); the backend is AGPL-3.0-or-later. Build steps: [$app_dir/README.md](https://github.com/${GITHUB_REPOSITORY:-Shamanthnp1/WAstatus}/blob/$tag/$app_dir/README.md)."
} > "$out"

echo "Release notes for $tag written to $out"
