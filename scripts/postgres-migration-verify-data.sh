#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-}"
TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-}"
MIGRATION_SCHEMAS="${MIGRATION_SCHEMAS:-public drizzle}"
MIGRATION_EXCLUDED_SCHEMAS="${MIGRATION_EXCLUDED_SCHEMAS:-neon_auth neon_control_plane}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

identifier_csv() {
  local label="$1"
  local values="$2"
  local joined=""
  local identifier
  for identifier in $values; do
    [[ "$identifier" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
      fail "$label must contain only simple PostgreSQL identifiers"
    if [[ -n "$joined" ]]; then
      joined+=","
    fi
    joined+="$identifier"
  done
  [[ -n "$joined" ]] || fail "$label must not be empty"
  printf '%s' "$joined"
}

psql_readonly() {
  local connection_url="$1"
  shift
  PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}" \
    PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on" \
    psql "$connection_url" -X -v ON_ERROR_STOP=1 "$@"
}

[[ -n "$SOURCE_DATABASE_URL" ]] || fail "SOURCE_DATABASE_URL is required"
[[ -n "$TARGET_DATABASE_URL" ]] || fail "TARGET_DATABASE_URL is required"
[[ "${WRITES_FENCED:-false}" == 'true' ]] ||
  fail "WRITES_FENCED=true is required; full-table digests are only meaningful after writer fencing and subscriber catch-up"
command -v psql >/dev/null 2>&1 || fail "psql is required"

included_schemas="$(identifier_csv MIGRATION_SCHEMAS "$MIGRATION_SCHEMAS")"
excluded_schemas="$(identifier_csv MIGRATION_EXCLUDED_SCHEMAS "$MIGRATION_EXCLUDED_SCHEMAS")"
verification_directory="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-pg-data-verification.XXXXXX")"
trap 'rm -rf "$verification_directory"' EXIT
source_file="$verification_directory/source"
target_file="$verification_directory/target"

printf 'Computing source table counts and order-independent row digests...\n'
psql_readonly "$SOURCE_DATABASE_URL" -Atq \
  -v included_schemas="$included_schemas" \
  -v excluded_schemas="$excluded_schemas" \
  --file "$SCRIPT_DIR/postgres-table-digests.sql" >"$source_file"

printf 'Computing target table counts and order-independent row digests...\n'
psql_readonly "$TARGET_DATABASE_URL" -Atq \
  -v included_schemas="$included_schemas" \
  -v excluded_schemas="$excluded_schemas" \
  --file "$SCRIPT_DIR/postgres-table-digests.sql" >"$target_file"

if ! cmp -s "$source_file" "$target_file"; then
  printf 'Table data verification failed (relation, row count, or digest differs):\n' >&2
  diff -u "$source_file" "$target_file" || true
  exit 1
fi

printf 'All covered source/target table counts and row digests match.\n'
