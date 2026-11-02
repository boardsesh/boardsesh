#!/usr/bin/env bash
# Seal and verify the Metro transform store that mobile-ota-production.yml
# carries between OTA publishes as a `metro-ota-store-*` artifact. See
# docs/mobile-ota-updates.md, "Metro transform cache".
#
#   metro-cache-seal.sh seal   <store-dir>   before the store is packed and uploaded
#   metro-cache-seal.sh verify <store-dir>   after the store is unpacked, before any export
#
# Why: the store is only taken from earlier successful publish runs on trusted
# branches (scripts/ci/metro-cache-select.ts), and every tar member is checked
# before it is unpacked. The seal is the last check: an HMAC over every file in
# the store, keyed by METRO_CACHE_HMAC_KEY, a secret only the Production
# environment holds. Even an artifact from a trusted run is useless without it.
# A store whose MAC we cannot recompute is deleted and the export runs cold.
#
# The MAC also covers METRO_CACHE_PREFIX (the cache key, which carries the
# EXPO_PUBLIC_* hash). Without it, a genuine store sealed under old
# EXPO_PUBLIC_* values could be renamed into the current key.
#
# Env:
#   METRO_CACHE_HMAC_KEY   the secret. Never printed, never put on a command line.
#   METRO_CACHE_PREFIX     the cache key prefix this store belongs to.
#   METRO_CACHE_MAX_BYTES  size budget, default 1 GiB (see the doc for why).
#
# verify never fails the job for a bad store: it deletes it and exits 0. seal
# exits non-zero when the store must not be saved (no key, over budget, not
# Metro's layout), and the workflow skips the save on that.
set -euo pipefail

mode="${1:?usage: metro-cache-seal.sh seal|verify <store-dir>}"
store="${2:?usage: metro-cache-seal.sh seal|verify <store-dir>}"
seal_name='.metro-ota-seal'
seal_version='metro-ota-seal-v1'
max_bytes="${METRO_CACHE_MAX_BYTES:-1073741824}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

# Sorted relative paths with the sha256 of each regular file. sha256sum escapes
# awkward file names, so distinct trees always give distinct manifests.
manifest() {
  (cd "$store" && find . -type f ! -path "./$seal_name" -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum --)
}

# HMAC-SHA256 of stdin, bound to the seal version and the cache key prefix.
# Node reads the key from its environment, so it never reaches argv or a log.
mac() {
  node -e '
    const { createHmac } = require("node:crypto");
    const hmac = createHmac("sha256", process.env.METRO_CACHE_HMAC_KEY);
    hmac.update(`${process.argv[1]}\n${process.env.METRO_CACHE_PREFIX ?? ""}\n`);
    process.stdin.on("data", (chunk) => hmac.update(chunk));
    process.stdin.on("end", () => process.stdout.write(hmac.digest("hex")));
  ' "$seal_version"
}

# The only layout Metro's binary FileStore writes (@expo/metro-config
# binary-file-store.js): 256 two-hex-digit shard directories at depth 1, each
# holding `<hex>.mp` entries, plus our own seal at the root. Anything else
# (symlinks, fifos, deeper paths, other names) is refused outright rather than
# reasoned about. Prints the first offending path, or nothing.
first_nonconforming() {
  (cd "$store" && find . -regextype posix-extended -mindepth 1 \
    ! \( -type d -regex '\./[0-9a-f]{2}' \) \
    ! \( -type f -regex '\./[0-9a-f]{2}/[0-9a-f]+\.mp' \) \
    ! \( -type f -path "./$seal_name" \) \
    -print -quit)
}

store_bytes() {
  du -sb "$store" | cut -f1
}

case "$mode" in
  seal)
    if [ -z "${METRO_CACHE_HMAC_KEY:-}" ]; then
      echo 'METRO_CACHE_HMAC_KEY is not set; not sealing, so not saving.'
      exit 1
    fi
    [ -d "$store" ] || { echo "No store at $store; nothing to save."; exit 1; }
    rm -f "$store/$seal_name"
    # A write Metro never finished leaves `.tmp<pid>_<name>` beside its target.
    find "$store" -mindepth 2 -maxdepth 2 -type f -name '.tmp*' -delete
    offender="$(first_nonconforming)"
    if [ -n "$offender" ]; then
      echo "::warning::The Metro store holds $offender, which is not Metro's layout; not saving it."
      exit 1
    fi
    bytes="$(store_bytes)"
    if [ "$bytes" -gt "$max_bytes" ]; then
      echo "::warning::The Metro store is $bytes bytes, over the $max_bytes-byte budget; not saving it."
      echo "Metro cache: not saved, store is $bytes bytes (budget $max_bytes)." >> "$summary"
      exit 1
    fi
    manifest_file="$(mktemp)"
    trap 'rm -f "$manifest_file"' EXIT
    manifest > "$manifest_file"
    digest="$(mac < "$manifest_file")"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { echo 'Could not compute the seal.'; exit 1; }
    { printf '%s %s\n' "$seal_version" "$digest"; cat "$manifest_file"; } > "$store/$seal_name"
    echo "Sealed $(wc -l < "$manifest_file") Metro cache files ($bytes bytes)."
    ;;

  verify)
    # Empties the store and exits 0, so the export runs cold. A planted archive
    # can carry read-only directories, so restore write permission first. If
    # the store still cannot be removed, set -e fails the script, and the
    # workflow keeps the exports away from it.
    wipe() {
      chmod -R u+rwX "$store" 2> /dev/null || true
      rm -rf "$store"
      mkdir -p "$store"
      exit 0
    }
    reject() {
      echo "::warning::Metro cache rejected: $1. Building cold."
      echo "Metro cache: rejected ($1); this export ran cold." >> "$summary"
      wipe
    }
    mkdir -p "$store"
    if [ -z "$(find "$store" -mindepth 1 -print -quit)" ]; then
      echo 'No Metro store to verify; building cold.'
      exit 0
    fi
    [ -n "${METRO_CACHE_HMAC_KEY:-}" ] || reject 'no METRO_CACHE_HMAC_KEY to check it with'
    [ -z "$(first_nonconforming)" ] || reject 'it holds something other than Metro shard directories and entries'
    # Checked before hashing, so an oversized store costs no hashing time.
    # Restore-keys carry every earlier transform forward, so a genuine store
    # only grows until the lockfile changes. Past the budget, start fresh.
    bytes="$(store_bytes)"
    if [ "$bytes" -gt "$max_bytes" ]; then
      echo "Metro cache is $bytes bytes, over the $max_bytes-byte budget; starting fresh."
      echo "Metro cache: dropped at $bytes bytes (budget $max_bytes); this export ran cold." >> "$summary"
      wipe
    fi
    [ -f "$store/$seal_name" ] || reject 'it carries no seal'
    seal_line="$(head -n 1 "$store/$seal_name")"
    expected="${seal_line#"$seal_version "}"
    [[ "$seal_line" == "$seal_version "* && "$expected" =~ ^[0-9a-f]{64}$ ]] || reject 'its seal is malformed'
    # Recomputed from the files on disk. The stored manifest is never trusted.
    actual="$(manifest | mac)"
    [ "$actual" = "$expected" ] || reject 'its seal does not match its files'
    rm -f "$store/$seal_name"
    # A genuine store can still carry a read-only directory, and Metro's set()
    # would then throw mid-export. The modes were never part of the seal.
    chmod -R u+rwX "$store"
    echo "Metro cache verified ($bytes bytes)."
    ;;

  *)
    echo "Unknown mode: $mode" >&2
    exit 2
    ;;
esac
