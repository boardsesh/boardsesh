#!/usr/bin/env bash
set -Eeuo pipefail

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-pg18-entrypoint.XXXXXX")"
readonly TEST_ROOT
trap 'rm -rf "$TEST_ROOT"' EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly ENTRYPOINT="$SCRIPT_DIR/dev-db-entrypoint.sh"
readonly SEED="$TEST_ROOT/seed/18/docker"
readonly SEED_MARKER="$TEST_ROOT/seed/SEED_COMPLETE"
readonly FAKE_BIN="$TEST_ROOT/bin"

mkdir -p "$SEED" "$FAKE_BIN"
printf '18\n' >"$SEED/PG_VERSION"
printf 'seeded\n' >"$SEED_MARKER"
printf 'original\n' >"$SEED/sentinel"

# The generated stub must expand these variables when it runs, not while this
# test writes it.
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >"$BOARDSESH_ENTRYPOINT_RESULT"\n' >"$FAKE_BIN/docker-entrypoint.sh"
chmod +x "$FAKE_BIN/docker-entrypoint.sh"

run_entrypoint() {
  local postgres_root="$1"
  local result_file="$2"
    BOARDSESH_POSTGRES_ROOT="$postgres_root" \
    BOARDSESH_DEV_DB_SEED="$SEED" \
    BOARDSESH_DEV_DB_SEED_MARKER="$SEED_MARKER" \
    BOARDSESH_ENTRYPOINT_RESULT="$result_file" \
    PGDATA="$postgres_root/18/docker" \
    PATH="$FAKE_BIN:$PATH" \
    "$ENTRYPOINT" postgres -c max_connections=25
}

readonly FRESH_ROOT="$TEST_ROOT/fresh"
readonly FIRST_RESULT="$TEST_ROOT/first-result"
run_entrypoint "$FRESH_ROOT" "$FIRST_RESULT"
[[ "$(<"$FRESH_ROOT/18/docker/sentinel")" == 'original' ]]
[[ "$(<"$FIRST_RESULT")" == 'postgres -c max_connections=25' ]]

printf 'changed-after-first-start\n' >"$FRESH_ROOT/18/docker/sentinel"
readonly RESTART_RESULT="$TEST_ROOT/restart-result"
run_entrypoint "$FRESH_ROOT" "$RESTART_RESULT"
[[ "$(<"$FRESH_ROOT/18/docker/sentinel")" == 'changed-after-first-start' ]]
[[ "$(<"$RESTART_RESULT")" == 'postgres -c max_connections=25' ]]

readonly LEGACY_ROOT="$TEST_ROOT/legacy"
mkdir -p "$LEGACY_ROOT"
printf '17\n' >"$LEGACY_ROOT/PG_VERSION"
if run_entrypoint "$LEGACY_ROOT" "$TEST_ROOT/legacy-result" 2>"$TEST_ROOT/legacy-error"; then
  printf 'expected a legacy PostgreSQL volume to be rejected\n' >&2
  exit 1
fi
grep -Fq 'contains a PostgreSQL 17 cluster' "$TEST_ROOT/legacy-error"

readonly PARTIAL_ROOT="$TEST_ROOT/partial-copy"
mkdir -p "$PARTIAL_ROOT/18/docker/base"
printf '18\n' >"$PARTIAL_ROOT/18/docker/PG_VERSION"
printf 'partial\n' >"$PARTIAL_ROOT/18/docker/base/1"
if run_entrypoint "$PARTIAL_ROOT" "$TEST_ROOT/partial-result" 2>"$TEST_ROOT/partial-error"; then
  printf 'expected an interrupted PostgreSQL 18 seed copy to be rejected\n' >&2
  exit 1
fi
grep -Fq 'is incomplete' "$TEST_ROOT/partial-error"

readonly PARTIAL_WITHOUT_VERSION_ROOT="$TEST_ROOT/partial-without-version"
mkdir -p "$PARTIAL_WITHOUT_VERSION_ROOT/18/docker/base"
printf 'partial\n' >"$PARTIAL_WITHOUT_VERSION_ROOT/18/docker/base/1"
if run_entrypoint \
  "$PARTIAL_WITHOUT_VERSION_ROOT" \
  "$TEST_ROOT/partial-without-version-result" \
  2>"$TEST_ROOT/partial-without-version-error"; then
  printf 'expected a non-empty PGDATA without PG_VERSION to be rejected\n' >&2
  exit 1
fi
grep -Fq 'PGDATA is partially initialized' "$TEST_ROOT/partial-without-version-error"

readonly UNSEEDED_ROOT="$TEST_ROOT/unseeded"
mkdir -p "$UNSEEDED_ROOT/18/docker"
printf '18\n' >"$UNSEEDED_ROOT/18/docker/PG_VERSION"
if run_entrypoint "$UNSEEDED_ROOT" "$TEST_ROOT/unseeded-result" 2>"$TEST_ROOT/unseeded-error"; then
  printf 'expected an unseeded PostgreSQL 18 volume to be rejected\n' >&2
  exit 1
fi
grep -Fq 'is incomplete or is not a Boardsesh seeded dev database' "$TEST_ROOT/unseeded-error"

printf 'PostgreSQL 18 dev-db entrypoint contract passed.\n'
