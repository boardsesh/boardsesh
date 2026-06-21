#!/usr/bin/env bash
set -euo pipefail

# Verify that every 64-bit native library (.so) bundled in an Android APK or AAB
# has its ELF LOAD segments aligned to >= 16 KB (0x4000). Apps targeting Android
# 15+ (API 35+) must support 16 KB memory page sizes: a 4 KB-aligned .so fails to
# dlopen on 16 KB-page devices (Pixel 8/9, etc.) with "not 16 KB aligned" →
# UnsatisfiedLinkError, and Google Play rejects the AAB at upload. This check is
# the CI guard that proves our own libs (the board-renderer JNI wrapper + prebuilt
# Rust FFI) are aligned and catches any third-party lib that regresses.
#
# 64-bit ONLY: the 16 KB requirement applies to arm64-v8a and x86_64. 16 KB-page
# devices run a 64-bit kernel and never load 32-bit code, so Google Play does not
# enforce 16 KB on armeabi-v7a / x86 — those ship 4 KB-aligned by design. Auditing
# them too would false-fail every release, so 32-bit ABIs are skipped below.
#
# Usage: scripts/check-16kb-alignment.sh <path-to-apk-or-aab> [more-archives...]
#
# Requires: unzip, readelf (GNU binutils — preinstalled on ubuntu-latest runners).

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <archive.apk|archive.aab> [more-archives...]" >&2
  exit 2
fi

# 16 KB in bytes; a LOAD segment's p_align must be at least this.
MIN_ALIGN=16384

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

overall_fail=0
checked_any=0

for archive in "$@"; do
  if [ ! -f "$archive" ]; then
    echo "::error::Archive not found: $archive"
    overall_fail=1
    continue
  fi

  echo "==> Checking native libraries in $archive"
  dir="$workdir/$(basename "$archive").extracted"
  mkdir -p "$dir"
  # APKs store libs under lib/<abi>/*.so; AABs under base/lib/<abi>/*.so. Pull both.
  # unzip exits 11 when the archive has no matching .so (handled by the no-.so
  # warning below); any other non-zero code is a real extraction failure — surface
  # it instead of silently reporting a false-green "0 libs checked".
  unzip_status=0
  unzip -qo "$archive" '*.so' -d "$dir" || unzip_status=$?
  if [ "$unzip_status" -ne 0 ] && [ "$unzip_status" -ne 11 ]; then
    echo "::error::Failed to extract $archive (unzip exit $unzip_status)"
    overall_fail=1
    continue
  fi

  found_so=0
  while IFS= read -r -d '' so; do
    found_so=1
    rel="${so#"$dir"/}"

    # 64-bit only (see header): the ABI is the directory directly holding the .so
    # (lib/<abi>/… or base/lib/<abi>/…). Skip 32-bit ABIs, which legitimately ship
    # 4 KB-aligned. Matched exactly so x86_64 is NOT caught by the x86 case.
    abi="$(basename "$(dirname "$so")")"
    case "$abi" in
    armeabi-v7a | x86)
      echo "  skip (32-bit ABI, 16 KB N/A): $rel"
      continue
      ;;
    esac
    checked_any=1

    # Collect the p_align of every LOAD segment (last column of each LOAD line),
    # e.g. "0x4000" or "0x1000". readelf -W avoids line-wrapping the wide output.
    bad_aligns=""
    while IFS= read -r align; do
      [ -n "$align" ] || continue
      # Bash understands the 0x… hex literal directly.
      if [ "$((align))" -lt "$MIN_ALIGN" ]; then
        bad_aligns="${bad_aligns:+$bad_aligns }$align"
      fi
    done < <(readelf -lW "$so" | awk '$1 == "LOAD" { print $NF }')

    if [ -n "$bad_aligns" ]; then
      echo "::error::$rel has LOAD segment alignment below 16 KB: $bad_aligns"
      overall_fail=1
    else
      echo "  OK (16 KB aligned): $rel"
    fi
  done < <(find "$dir" -type f -name '*.so' -print0)

  if [ "$found_so" -eq 0 ]; then
    # A release APK/AAB always ships native libs; zero .so means a stripped or
    # malformed artifact. Fail rather than pass silently (false green).
    echo "::error::No .so files found in $archive"
    overall_fail=1
  fi
done

if [ "$checked_any" -eq 0 ]; then
  echo "::error::No native libraries were checked."
  overall_fail=1
fi

if [ "$overall_fail" -ne 0 ]; then
  echo "::error::One or more native libraries are not 16 KB page aligned (Android 15+ / Play requirement)."
  exit 1
fi

echo "==> All native libraries are 16 KB page aligned."
