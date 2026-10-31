#!/bin/bash
# Select only the build toolchain here. Duo runtime installation remains in its shard.
set -euo pipefail
candidates=""
for candidate in /Applications/Xcode.app /Applications/Xcode_27*.app /Applications/Xcode-27*.app; do
  [ -d "$candidate" ] || continue
  case "$candidate" in *[Bb]eta*|*_RC*|*-RC*|*Release_Candidate*) continue ;; esac
  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$candidate/Contents/Info.plist" 2>/dev/null || true)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || continue
  lowest="$(printf '%s\n%s\n' 27.1 "$version" | sort -V | head -n 1)"
  [ "$lowest" = "27.1" ] || continue
  candidates="${candidates}${version} ${candidate}"$'\n'
done
xcode="$(printf '%s' "$candidates" | sort -V | tail -n 1 | cut -d' ' -f2-)"
if [ -z "$xcode" ]; then
  echo "::error::Screenshot capture needs a release Xcode 27.1 or later; found none under /Applications."
  exit 1
fi
export DEVELOPER_DIR="$xcode/Contents/Developer"
printf 'DEVELOPER_DIR=%s\n' "$DEVELOPER_DIR" >> "$GITHUB_ENV"
xcodebuild -version
