#!/usr/bin/env bash
set -Eeuo pipefail

readonly EXPECTED_POSTGRES_MAJOR=18
readonly POSTGRES_ROOT="${BOARDSESH_POSTGRES_ROOT:-/var/lib/postgresql}"
readonly EXPECTED_PGDATA="${POSTGRES_ROOT}/${EXPECTED_POSTGRES_MAJOR}/docker"
readonly SEED_PGDATA="${BOARDSESH_DEV_DB_SEED:-/usr/local/share/boardsesh-dev-db/18/docker}"
readonly SEED_COMPLETE_MARKER="${BOARDSESH_DEV_DB_SEED_MARKER:-/usr/local/share/boardsesh-dev-db/SEED_COMPLETE}"
readonly RUNTIME_READY_MARKER="${PGDATA:-$EXPECTED_PGDATA}/.boardsesh-dev-db-ready"

fail() {
  printf 'boardsesh-dev-db: %s\n' "$*" >&2
  exit 1
}

read_major() {
  tr -d '[:space:]' <"$1/PG_VERSION"
}

validate_seed() {
  [[ -s "$SEED_PGDATA/PG_VERSION" ]] || fail "image seed is missing PG_VERSION"
  [[ -f "$SEED_COMPLETE_MARKER" ]] || fail "image seed completion marker is missing"

  local seed_major
  seed_major="$(read_major "$SEED_PGDATA")"
  [[ "$seed_major" == "$EXPECTED_POSTGRES_MAJOR" ]] ||
    fail "image seed is PostgreSQL ${seed_major}; expected ${EXPECTED_POSTGRES_MAJOR}"
}

reject_other_clusters() {
  local version_file cluster_major
  while IFS= read -r -d '' version_file; do
    cluster_major="$(read_major "${version_file%/PG_VERSION}")"
    fail "mounted parent volume contains a PostgreSQL ${cluster_major} cluster outside ${PGDATA}; use a fresh PostgreSQL 18 volume"
  done < <(
    # A valid cluster also contains per-database base/<oid>/PG_VERSION files.
    # Prune the expected PGDATA subtree entirely; prepare_pgdata validates its
    # top-level version and completion marker separately below.
    find "$POSTGRES_ROOT" -path "$PGDATA" -prune -o \
      -type f -name PG_VERSION -print0 2>/dev/null
  )
}

prepare_pgdata() {
  [[ "${PGDATA:-}" == "$EXPECTED_PGDATA" ]] ||
    fail "PGDATA must be ${EXPECTED_PGDATA}; got ${PGDATA:-<unset>}"

  validate_seed
  mkdir -p "$POSTGRES_ROOT"
  reject_other_clusters

  if [[ -s "$PGDATA/PG_VERSION" ]]; then
    local mounted_major
    mounted_major="$(read_major "$PGDATA")"
    [[ "$mounted_major" == "$EXPECTED_POSTGRES_MAJOR" ]] ||
      fail "mounted PGDATA is PostgreSQL ${mounted_major}; expected ${EXPECTED_POSTGRES_MAJOR}"
    [[ -f "$RUNTIME_READY_MARKER" ]] ||
      fail "mounted PostgreSQL 18 cluster is incomplete or is not a Boardsesh seeded dev database"
    return
  fi

  if [[ -d "$PGDATA" ]] && find "$PGDATA" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    fail "PGDATA is partially initialized; use a fresh PostgreSQL 18 volume"
  fi

  printf 'boardsesh-dev-db: initializing a fresh PostgreSQL 18 volume from the image seed\n'
  mkdir -p "$PGDATA"
  cp -a "$SEED_PGDATA"/. "$PGDATA"/
  if [[ "$(id -u)" == '0' ]]; then
    # The image seed is postgres-owned, but rootless/overlay copy semantics can
    # change ownership below PGDATA. This recursive repair happens only on the
    # first seed copy, never on normal restarts.
    chown -R postgres:postgres "$PGDATA"
    install -o postgres -g postgres -m 0600 /dev/null "$RUNTIME_READY_MARKER"
  else
    touch "$RUNTIME_READY_MARKER"
  fi
}

prepare_pgdata

exec docker-entrypoint.sh "$@"
