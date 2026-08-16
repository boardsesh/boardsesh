#!/usr/bin/env bash
if [[ $- == *x* ]]; then
  set +x
fi
set -Eeuo pipefail
umask 077

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-}"
TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-}"
MIGRATION_SCHEMAS="${MIGRATION_SCHEMAS:-public drizzle}"
MIGRATION_EXCLUDED_SCHEMAS="${MIGRATION_EXCLUDED_SCHEMAS:-neon_auth neon_control_plane}"
EXPECTED_SOURCE_DATABASE="${EXPECTED_SOURCE_DATABASE:-railway}"
EXPECTED_TARGET_DATABASE="${EXPECTED_TARGET_DATABASE:-railway}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_VERIFY_CONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"
# shellcheck source=scripts/lib/postgres-credentials.sh
source "$SCRIPT_DIR/lib/postgres-credentials.sh"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

identifier_csv() {
  local label="$1"
  local values="$2"
  local joined="" seen=' '
  local identifier
  for identifier in $values; do
    [[ "$identifier" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
      fail "$label must contain only simple PostgreSQL identifiers"
    [[ "$seen" != *" $identifier "* ]] || fail "$label contains duplicate schema $identifier"
    seen+="$identifier "
    if [[ -n "$joined" ]]; then
      joined+=","
    fi
    joined+="$identifier"
  done
  [[ -n "$joined" ]] || fail "$label must not be empty"
  printf '%s' "$joined"
}

validate_schema_policy_lists() {
  local schema included_seen=' ' excluded_seen=' '
  for schema in $MIGRATION_SCHEMAS; do
    [[ "$schema" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
      fail 'MIGRATION_SCHEMAS must contain only simple PostgreSQL identifiers'
    [[ "$included_seen" != *" $schema "* ]] ||
      fail "MIGRATION_SCHEMAS contains duplicate schema $schema"
    included_seen+="$schema "
  done
  [[ "$included_seen" != ' ' ]] || fail 'MIGRATION_SCHEMAS must not be empty'
  for schema in $MIGRATION_EXCLUDED_SCHEMAS; do
    [[ "$schema" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
      fail 'MIGRATION_EXCLUDED_SCHEMAS must contain only simple PostgreSQL identifiers'
    [[ "$excluded_seen" != *" $schema "* ]] ||
      fail "MIGRATION_EXCLUDED_SCHEMAS contains duplicate schema $schema"
    [[ "$included_seen" != *" $schema "* ]] ||
      fail "schema $schema cannot appear in both MIGRATION_SCHEMAS and MIGRATION_EXCLUDED_SCHEMAS"
    excluded_seen+="$schema "
  done
  [[ "$excluded_seen" != ' ' ]] || fail 'MIGRATION_EXCLUDED_SCHEMAS must not be empty'
}

assert_schema_manifest() {
  local connection_name="$1" schema requested_values='' missing_schema_count
  for schema in $MIGRATION_SCHEMAS; do
    requested_values+="${requested_values:+, }('$schema')"
  done
  missing_schema_count="$(psql_readonly "$connection_name" -Atq -c "
SELECT count(*)
FROM (VALUES ${requested_values}) AS requested(schema_name)
WHERE pg_catalog.to_regnamespace(requested.schema_name) IS NULL;")"
  [[ "$missing_schema_count" == '0' ]] ||
    fail "$connection_name is missing $missing_schema_count schema(s) named by MIGRATION_SCHEMAS"
}

psql_readonly() {
  local connection_name="$1"
  shift
  BOARDSESH_LIBPQ_CONNECT_TIMEOUT="$MIGRATION_VERIFY_CONNECT_TIMEOUT" \
    BOARDSESH_LIBPQ_EXTRA_OPTIONS='-c default_transaction_read_only=on' \
    boardsesh_run_libpq_connection "$connection_name" \
      psql -X -v ON_ERROR_STOP=1 "$@"
}

[[ -n "$SOURCE_DATABASE_URL" ]] || fail "SOURCE_DATABASE_URL is required"
[[ -n "$TARGET_DATABASE_URL" ]] || fail "TARGET_DATABASE_URL is required"
[[ "${WRITES_FENCED:-false}" == 'true' ]] ||
  fail "WRITES_FENCED=true is required; full-table digests are only meaningful after writer fencing and subscriber catch-up"
command -v psql >/dev/null 2>&1 || fail "psql is required"

validate_schema_policy_lists
included_schemas="$(identifier_csv MIGRATION_SCHEMAS "$MIGRATION_SCHEMAS")"
excluded_schemas="$(identifier_csv MIGRATION_EXCLUDED_SCHEMAS "$MIGRATION_EXCLUDED_SCHEMAS")"
verification_directory="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-pg-data-verification.XXXXXX")"
trap 'rm -rf "$verification_directory"' EXIT
credential_directory="$verification_directory/credentials"
mkdir -m 0700 "$credential_directory"
boardsesh_prepare_libpq_connection SOURCE "$SOURCE_DATABASE_URL" "$credential_directory"
boardsesh_prepare_libpq_connection TARGET "$TARGET_DATABASE_URL" "$credential_directory"
SOURCE_DATABASE_URL=SOURCE
TARGET_DATABASE_URL=TARGET
unset DATABASE_URL POSTGRES_URL PGPASSWORD
source_file="$verification_directory/source"
target_file="$verification_directory/target"

source_database_name="$(psql_readonly "$SOURCE_DATABASE_URL" -Atq -c 'SELECT current_database();')"
target_database_name="$(psql_readonly "$TARGET_DATABASE_URL" -Atq -c 'SELECT current_database();')"
[[ "$source_database_name" == "$EXPECTED_SOURCE_DATABASE" ]] ||
  fail "source database is $source_database_name; expected canonical database $EXPECTED_SOURCE_DATABASE"
[[ "$target_database_name" == "$EXPECTED_TARGET_DATABASE" ]] ||
  fail "target database is $target_database_name; expected canonical database $EXPECTED_TARGET_DATABASE"
assert_schema_manifest "$SOURCE_DATABASE_URL"
assert_schema_manifest "$TARGET_DATABASE_URL"

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
