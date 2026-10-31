#!/bin/bash
# Select only the build toolchain here. Duo runtime installation remains in its shard.
set -euo pipefail

screenshot_xcode_version() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist"
}

select_screenshot_xcode() {
  local applications_dir="${1:-/Applications}"
  local candidates="" candidate canonical canonical_name version lowest xcode
  for candidate in "$applications_dir"/Xcode.app "$applications_dir"/Xcode_27*.app "$applications_dir"/Xcode-27*.app; do
    [ -d "$candidate" ] || continue
    # Runner aliases such as Xcode_27.2.0.app can point at a release candidate.
    # Inspect and export the physical app path, never only its display alias.
    canonical="$(cd "$candidate" && pwd -P)"
    canonical_name="$(printf '%s' "${canonical##*/}" | tr '[:upper:]' '[:lower:]')"
    case "$canonical_name" in
      *beta*|*_rc*|*-rc*|*.rc*|*release*candidate*)
        printf '[screenshot-xcode] Rejected prerelease %s -> %s\n' "$candidate" "$canonical" >&2
        continue
        ;;
    esac
    version="$(screenshot_xcode_version "$canonical" 2>/dev/null || true)"
    [[ "$version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || continue
    lowest="$(printf '%s\n%s\n' 27.1 "$version" | sort -V | head -n 1)"
    [ "$lowest" = "27.1" ] || continue
    printf '[screenshot-xcode] Accepted %s -> %s (Xcode %s)\n' "$candidate" "$canonical" "$version" >&2
    candidates="${candidates}${version} ${canonical}"$'\n'
  done
  xcode="$(printf '%s' "$candidates" | sort -V | tail -n 1 | cut -d' ' -f2-)"
  if [ -z "$xcode" ]; then
    echo "::error::Screenshot capture needs a release Xcode 27.1 or later; found none under $applications_dir." >&2
    return 1
  fi
  export DEVELOPER_DIR="$xcode/Contents/Developer"
  printf 'DEVELOPER_DIR=%s\n' "$DEVELOPER_DIR" >> "$GITHUB_ENV"
  printf '[screenshot-xcode] Selected %s\n' "$DEVELOPER_DIR" >&2
  xcodebuild -version
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  select_screenshot_xcode
fi
