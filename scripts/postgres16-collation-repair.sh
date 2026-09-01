#!/usr/bin/env bash
if [[ $- == *x* ]]; then
  set +x
fi
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/postgres-credentials.sh
source "$SCRIPT_DIR/lib/postgres-credentials.sh"

EXPECTED_DATABASE="${EXPECTED_DATABASE:-railway}"
EXPECTED_SOURCE_MAJOR="${EXPECTED_SOURCE_MAJOR:-16}"
ADMIN_DATABASE_URL="${ADMIN_DATABASE_URL:-}"
SOURCE_IMAGE_REFERENCE="${SOURCE_IMAGE_REFERENCE:-UNVERIFIED}"
SOURCE_IMAGE_PIN_CONFIRMED="${SOURCE_IMAGE_PIN_CONFIRMED:-false}"
CONNECTION_CONTAINMENT_VERIFIED="${CONNECTION_CONTAINMENT_VERIFIED:-false}"
CONNECTION_CONTAINMENT_EVIDENCE_SHA256="${CONNECTION_CONTAINMENT_EVIDENCE_SHA256:-UNVERIFIED}"
MIN_FREE_CONNECTIONS="${MIN_FREE_CONNECTIONS:-20}"
MAX_CONNECTION_PERCENT="${MAX_CONNECTION_PERCENT:-60}"
MAX_TRANSACTION_AGE_SECONDS="${MAX_TRANSACTION_AGE_SECONDS:-300}"
MAX_IDLE_TRANSACTION_AGE_SECONDS="${MAX_IDLE_TRANSACTION_AGE_SECONDS:-60}"
RESOURCE_SAMPLE_MAX_AGE_SECONDS="${RESOURCE_SAMPLE_MAX_AGE_SECONDS:-300}"
MAX_CPU_PERCENT_15M="${MAX_CPU_PERCENT_15M:-50}"
MAX_MEMORY_PERCENT="${MAX_MEMORY_PERCENT:-70}"
MIN_MEMORY_FREE_BYTES="${MIN_MEMORY_FREE_BYTES:-6442450944}"
MIN_DISK_FREE_BASE_BYTES="${MIN_DISK_FREE_BASE_BYTES:-5368709120}"
MAX_PROJECTED_DISK_PERCENT="${MAX_PROJECTED_DISK_PERCENT:-75}"
REINDEX_LOCK_TIMEOUT_MS="${REINDEX_LOCK_TIMEOUT_MS:-5000}"
REINDEX_STATEMENT_TIMEOUT_MS="${REINDEX_STATEMENT_TIMEOUT_MS:-21600000}"
SYSTEM_REINDEX_STATEMENT_TIMEOUT_MS="${SYSTEM_REINDEX_STATEMENT_TIMEOUT_MS:-3600000}"
REINDEX_MAINTENANCE_WORK_MEM="${REINDEX_MAINTENANCE_WORK_MEM:-1GB}"
REINDEX_MAX_PARALLEL_MAINTENANCE_WORKERS="${REINDEX_MAX_PARALLEL_MAINTENANCE_WORKERS:-0}"

CREDENTIALS_DIRECTORY=''
STATE_LOCK_DIRECTORY=''

usage() {
  cat <<'USAGE'
Usage: scripts/postgres16-collation-repair.sh COMMAND STATE_DIRECTORY

Commands:
  audit           Capture an immutable cluster and full user-index manifest.
  status          Show completed and remaining concurrent user-index rebuilds.
  reindex-next    Rebuild the next user index with REINDEX INDEX CONCURRENTLY.
  reindex-system  Rebuild system-catalog indexes during a fenced maintenance window.
  amcheck         Run the fenced production pg_amcheck and write bound evidence.
  validate        Prove the rebuild, catalog, constraint, and PostGIS contracts.
  refresh         Refresh the database collation version after all validation passes.

Required for every command:
  ADMIN_DATABASE_URL              Direct PostgreSQL URL; never a PgBouncer URL.
  EXPECTED_SYSTEM_IDENTIFIER      Pre-known PostGIS - PROD system identifier. The
                                  audit refuses to discover its own write target.

Required when creating a production audit state:
  SOURCE_IMAGE_REFERENCE          Immutable image@sha256:<64 hex> Railway source pin.
  SOURCE_IMAGE_PIN_CONFIRMED=true Set only after Railway configuration and a fresh
                                  deployment both show that exact digest.
  CONNECTION_CONTAINMENT_VERIFIED=true
                                  PgBouncer/role rollout and the 24-hour soak passed.
  CONNECTION_CONTAINMENT_EVIDENCE_SHA256
                                  SHA-256 of the retained containment evidence bundle.

Required for reindex-next, reindex-system, amcheck, validate, and refresh:
  COLLATION_REPAIR_ACK            Exact token printed by audit.
  BACKUP_RESTORE_VERIFIED=true    Portable dump restored successfully into a clone.
  RESTORED_CLONE_AMCHECK_VERIFIED=true
                                  pg_amcheck and app probes passed on that clone.
  CONNECTION_CONTAINMENT_EVIDENCE_SHA256
                                  Exact evidence digest stored by the audit.

Additionally required for reindex-next:
  RESOURCE_SAMPLE_EPOCH           Unix time for the Railway resource sample.
  RESOURCE_CPU_PERCENT_15M        Railway 15-minute CPU average, as a percent.
  RESOURCE_MEMORY_BYTES           Current memory usage.
  RESOURCE_MEMORY_LIMIT_BYTES     Current memory limit.
  RESOURCE_DISK_FREE_BYTES        Current volume free bytes.
  RESOURCE_DISK_CAPACITY_BYTES    Current volume capacity bytes.

Required for reindex-system, amcheck, and refresh:
  WRITES_FENCED=true              Application writes are disabled.
  CLIENTS_FENCED=true             PgBouncer and direct application clients are fenced.
  MAINTENANCE_WINDOW_ACK          Exact maintenance token printed by audit.

refresh also requires:
  COLLATION_REFRESH_ACK           Exact refresh token printed by validate.

The audit and status commands are read-only. reindex-next handles exactly one
index so Railway CPU, memory, disk, and connection gates are sampled again before
every rebuild. amcheck requires a PostgreSQL client with the same major version
as the server. No command drops an object or cleans up a failed concurrent index.
USAGE
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$STATE_LOCK_DIRECTORY" && -d "$STATE_LOCK_DIRECTORY" &&
        ! -L "$STATE_LOCK_DIRECTORY" ]]; then
    if [[ -f "$STATE_LOCK_DIRECTORY/owner.tsv" && ! -L "$STATE_LOCK_DIRECTORY/owner.tsv" ]]; then
      rm -f -- "$STATE_LOCK_DIRECTORY/owner.tsv"
    fi
    rmdir -- "$STATE_LOCK_DIRECTORY" 2>/dev/null || true
    STATE_LOCK_DIRECTORY=''
  fi
  if [[ -n "$CREDENTIALS_DIRECTORY" && -d "$CREDENTIALS_DIRECTORY" ]]; then
    rm -rf -- "$CREDENTIALS_DIRECTORY"
  fi
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found in PATH"
}

require_integer() {
  local label="$1" number="$2"
  [[ "$number" =~ ^[0-9]+$ ]] || fail "$label must be a non-negative integer"
}

require_positive_integer() {
  local label="$1" number="$2"
  require_integer "$label" "$number"
  [[ "$number" -gt 0 ]] || fail "$label must be greater than zero"
}

require_decimal() {
  local label="$1" number="$2"
  [[ "$number" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "$label must be a non-negative number"
}

decimal_less_than() {
  awk -v observed="$1" -v limit="$2" 'BEGIN { exit !(observed < limit) }'
}

sha256_file() {
  local input_file="$1" digest_output
  if command -v sha256sum >/dev/null 2>&1; then
    digest_output="$(sha256sum "$input_file")"
    REPLY="${digest_output%% *}"
  elif command -v shasum >/dev/null 2>&1; then
    digest_output="$(shasum -a 256 "$input_file")"
    REPLY="${digest_output%% *}"
  elif command -v openssl >/dev/null 2>&1; then
    digest_output="$(openssl dgst -sha256 "$input_file")"
    REPLY="${digest_output##* }"
  else
    fail 'sha256sum, shasum, or openssl is required to fingerprint manifests'
  fi
  [[ "$REPLY" =~ ^[0-9a-f]{64}$ ]] || fail 'could not calculate a SHA-256 manifest digest'
}

validate_configuration() {
  [[ "$EXPECTED_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    fail 'EXPECTED_DATABASE must be a simple PostgreSQL identifier'
  require_positive_integer EXPECTED_SYSTEM_IDENTIFIER "${EXPECTED_SYSTEM_IDENTIFIER:-}"
  require_positive_integer EXPECTED_SOURCE_MAJOR "$EXPECTED_SOURCE_MAJOR"
  require_positive_integer MIN_FREE_CONNECTIONS "$MIN_FREE_CONNECTIONS"
  require_positive_integer MAX_CONNECTION_PERCENT "$MAX_CONNECTION_PERCENT"
  require_positive_integer MAX_TRANSACTION_AGE_SECONDS "$MAX_TRANSACTION_AGE_SECONDS"
  require_positive_integer MAX_IDLE_TRANSACTION_AGE_SECONDS "$MAX_IDLE_TRANSACTION_AGE_SECONDS"
  require_positive_integer RESOURCE_SAMPLE_MAX_AGE_SECONDS "$RESOURCE_SAMPLE_MAX_AGE_SECONDS"
  require_positive_integer MAX_CPU_PERCENT_15M "$MAX_CPU_PERCENT_15M"
  require_positive_integer MAX_MEMORY_PERCENT "$MAX_MEMORY_PERCENT"
  require_positive_integer MIN_MEMORY_FREE_BYTES "$MIN_MEMORY_FREE_BYTES"
  require_positive_integer MIN_DISK_FREE_BASE_BYTES "$MIN_DISK_FREE_BASE_BYTES"
  require_positive_integer MAX_PROJECTED_DISK_PERCENT "$MAX_PROJECTED_DISK_PERCENT"
  require_positive_integer REINDEX_LOCK_TIMEOUT_MS "$REINDEX_LOCK_TIMEOUT_MS"
  require_positive_integer REINDEX_STATEMENT_TIMEOUT_MS "$REINDEX_STATEMENT_TIMEOUT_MS"
  require_positive_integer SYSTEM_REINDEX_STATEMENT_TIMEOUT_MS "$SYSTEM_REINDEX_STATEMENT_TIMEOUT_MS"
  [[ "$REINDEX_MAINTENANCE_WORK_MEM" =~ ^[1-9][0-9]*(kB|MB|GB)$ ]] ||
    fail 'REINDEX_MAINTENANCE_WORK_MEM must be a positive PostgreSQL kB, MB, or GB value'
  require_integer REINDEX_MAX_PARALLEL_MAINTENANCE_WORKERS \
    "$REINDEX_MAX_PARALLEL_MAINTENANCE_WORKERS"
  [[ "$MAX_CONNECTION_PERCENT" -le 100 && "$MAX_CPU_PERCENT_15M" -le 100 &&
     "$MAX_MEMORY_PERCENT" -le 100 && "$MAX_PROJECTED_DISK_PERCENT" -le 100 ]] ||
    fail 'percentage gates must be between 1 and 100'
  [[ "$SOURCE_IMAGE_PIN_CONFIRMED" == 'true' || "$SOURCE_IMAGE_PIN_CONFIRMED" == 'false' ]] ||
    fail 'SOURCE_IMAGE_PIN_CONFIRMED must be true or false'
  [[ "$CONNECTION_CONTAINMENT_VERIFIED" == 'true' ||
     "$CONNECTION_CONTAINMENT_VERIFIED" == 'false' ]] ||
    fail 'CONNECTION_CONTAINMENT_VERIFIED must be true or false'
  [[ "$CONNECTION_CONTAINMENT_EVIDENCE_SHA256" == 'UNVERIFIED' ||
     "$CONNECTION_CONTAINMENT_EVIDENCE_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'CONNECTION_CONTAINMENT_EVIDENCE_SHA256 must be UNVERIFIED or 64 lowercase hex characters'
}

state_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

assert_secure_state_directory() {
  local state_directory="$1" mode
  [[ -d "$state_directory" && ! -L "$state_directory" ]] ||
    fail "state directory does not exist or is a symlink: $state_directory"
  mode="$(state_mode "$state_directory")"
  [[ "$mode" =~ ^[0-7]+$ ]] || fail 'could not determine state-directory permissions'
  (((8#$mode & 077) == 0)) || fail 'state directory must not be accessible by group or other users'
  for required_file in format metadata.tsv indexes.tsv collations.csv completed-indexes.txt; do
    [[ -f "$state_directory/$required_file" && ! -L "$state_directory/$required_file" ]] ||
      fail "state file is missing or is a symlink: $required_file"
  done
  [[ "$(<"$state_directory/format")" == 'boardsesh-postgres16-collation-repair-v3' ]] ||
    fail 'state directory has an unsupported format'
  assert_state_inventory "$state_directory"
}

tsv_value() {
  local input_file="$1" wanted_key="$2" file_label="$3" result
  result="$(awk -F '\t' -v wanted_key="$wanted_key" '
    $1 == wanted_key { matches += 1; result = $2 }
    END { if (matches == 1) print result; else exit 1 }
  ' "$input_file")" || fail "$file_label key is missing or duplicated: $wanted_key"
  printf '%s' "$result"
}

metadata_value() {
  local state_directory="$1" metadata_key="$2"
  tsv_value "$state_directory/metadata.tsv" "$metadata_key" metadata
}

assert_state_inventory() {
  local state_directory="$1" inventory_sha256 inventory_count
  sha256_file "$state_directory/indexes.tsv"
  inventory_sha256="$REPLY"
  [[ "$inventory_sha256" == "$(metadata_value "$state_directory" index_inventory_sha256)" ]] ||
    fail 'index inventory file does not match its audited SHA-256'
  inventory_count="$(awk 'NF { count += 1 } END { print count + 0 }' \
    "$state_directory/indexes.tsv")"
  [[ "$inventory_count" == "$(metadata_value "$state_directory" index_count)" ]] ||
    fail 'index inventory row count does not match audit metadata'
  awk -F '\t' '
    NF != 6 { exit 1 }
    $1 !~ /^[A-Za-z_][A-Za-z0-9_]*$/ || $2 !~ /^[A-Za-z_][A-Za-z0-9_]*$/ ||
      $3 !~ /^[A-Za-z_][A-Za-z0-9_]*$/ || $4 !~ /^[A-Za-z_][A-Za-z0-9_]*$/ { exit 1 }
    $5 !~ /^[0-9]+$/ || $6 !~ /^[0-9a-f]+$/ || length($6) % 2 != 0 { exit 1 }
    seen[$1 "." $2]++ { exit 1 }
  ' "$state_directory/indexes.tsv" ||
    fail 'index inventory contains an invalid or duplicate row'
}

state_marker_matches() {
  local state_directory="$1" marker_name="$2" expected_value="$3" marker_path
  marker_path="$state_directory/$marker_name"
  if [[ ! -e "$marker_path" && ! -L "$marker_path" ]]; then
    return 1
  fi
  [[ -f "$marker_path" && ! -L "$marker_path" ]] ||
    fail "state marker is not a regular file: $marker_name"
  [[ "$(<"$marker_path")" == "$expected_value" ]] ||
    fail "state marker does not match this repair: $marker_name"
}

acquire_state_lock() {
  local state_directory="$1" operation="$2" lock_directory
  lock_directory="$state_directory/.operation.lock"
  if ! mkdir -m 0700 -- "$lock_directory" 2>/dev/null; then
    fail "repair state is locked; inspect $lock_directory and recover it only after proving no operation is running"
  fi
  STATE_LOCK_DIRECTORY="$lock_directory"
  {
    printf 'pid\t%s\n' "$$"
    printf 'operation\t%s\n' "$operation"
    printf 'started_epoch\t%s\n' "$(date +%s)"
  } >"$lock_directory/owner.tsv"
  chmod 0600 "$lock_directory/owner.tsv"
}

write_state_marker() {
  local state_directory="$1" marker_name="$2" marker_value="$3" marker_path marker_temp
  [[ "$marker_name" =~ ^[A-Za-z0-9][A-Za-z0-9.-]+$ ]] ||
    fail 'state marker name is unsafe'
  [[ "$marker_value" != *$'\t'* && "$marker_value" != *$'\n'* ]] ||
    fail 'state marker value is unsafe'
  marker_path="$state_directory/$marker_name"
  [[ ! -e "$marker_path" && ! -L "$marker_path" ]] ||
    fail "refusing to replace existing state marker: $marker_name"
  marker_temp="$(mktemp "$state_directory/.${marker_name}.XXXXXX")"
  printf '%s\n' "$marker_value" >"$marker_temp"
  chmod 0600 "$marker_temp"
  mv -- "$marker_temp" "$marker_path"
}

append_completion_journal() {
  local state_directory="$1" qualified_index="$2" journal_file journal_temp journal_line
  journal_file="$state_directory/completed-indexes.txt"
  journal_temp="$(mktemp "$state_directory/.completed-indexes.XXXXXX")"
  while IFS= read -r journal_line || [[ -n "$journal_line" ]]; do
    printf '%s\n' "$journal_line" >>"$journal_temp"
  done <"$journal_file"
  printf '%s\n' "$qualified_index" >>"$journal_temp"
  chmod 0600 "$journal_temp"
  mv -- "$journal_temp" "$journal_file"
}

prepare_connection() {
  [[ -n "$ADMIN_DATABASE_URL" ]] || fail 'ADMIN_DATABASE_URL is required'
  CREDENTIALS_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-collation-repair.XXXXXX")"
  chmod 0700 "$CREDENTIALS_DIRECTORY"
  boardsesh_prepare_libpq_connection ADMIN "$ADMIN_DATABASE_URL" "$CREDENTIALS_DIRECTORY"
  ADMIN_DATABASE_URL=''
  unset DATABASE_URL POSTGRES_URL PGPASSWORD
}

run_readonly() {
  BOARDSESH_LIBPQ_CONNECT_TIMEOUT=10 \
    BOARDSESH_LIBPQ_EXTRA_OPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c application_name=boardsesh-collation-audit' \
    boardsesh_run_libpq_connection ADMIN psql -X -v ON_ERROR_STOP=1 "$@"
}

run_maintenance() {
  local extra_options="$1"
  shift
  BOARDSESH_LIBPQ_CONNECT_TIMEOUT=10 \
    BOARDSESH_LIBPQ_EXTRA_OPTIONS="$extra_options" \
    boardsesh_run_libpq_connection ADMIN psql -X -v ON_ERROR_STOP=1 "$@"
}

readonly_scalar() {
  run_readonly -Atq -c "$1"
}

assert_no_replication_objects() {
  local replication_object_count
  replication_object_count="$(readonly_scalar "
SELECT (SELECT count(*) FROM pg_catalog.pg_publication)
     + (SELECT count(*) FROM pg_catalog.pg_subscription)
     + (SELECT count(*) FROM pg_catalog.pg_replication_slots);")"
  [[ "$replication_object_count" == '0' ]] ||
    fail "$replication_object_count publication, subscription, or replication-slot objects exist"
}

cluster_snapshot() {
  run_readonly -Atq -F $'\t' <<'SQL'
SELECT current_setting('server_version_num'),
       current_database(),
       control.system_identifier,
       database.datcollate,
       database.datctype,
       database.datlocprovider,
       coalesce(database.datcollversion, ''),
       coalesce(pg_catalog.pg_database_collation_actual_version(database.oid), ''),
       current_role,
       role.rolsuper,
       current_setting('data_checksums'),
       current_setting('max_connections'),
       current_setting('superuser_reserved_connections')
FROM pg_catalog.pg_database AS database
CROSS JOIN pg_catalog.pg_control_system() AS control
JOIN pg_catalog.pg_roles AS role ON role.rolname = current_role
WHERE database.datname = current_database();
SQL
}

index_inventory_sql() {
  cat <<'SQL'
SELECT index_namespace.nspname,
       index_relation.relname,
       table_namespace.nspname,
       table_relation.relname,
       pg_catalog.pg_relation_size(index_relation.oid),
       pg_catalog.encode(
         pg_catalog.convert_to(pg_catalog.pg_get_indexdef(index_relation.oid), 'UTF8'), 'hex')
FROM pg_catalog.pg_index AS index_row
JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = index_row.indrelid
JOIN pg_catalog.pg_namespace AS table_namespace ON table_namespace.oid = table_relation.relnamespace
WHERE index_relation.relkind = 'i'
  AND table_relation.relpersistence <> 't'
  AND index_namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
  AND index_namespace.nspname <> 'information_schema'
ORDER BY pg_catalog.pg_relation_size(index_relation.oid) DESC,
         index_namespace.nspname,
         index_relation.relname;
SQL
}

manifest_snapshot() {
  local canonical_manifest="$CREDENTIALS_DIRECTORY/current-index-manifest.jsonl" manifest_count
  run_readonly -Atq -o "$canonical_manifest" <<'SQL'
SELECT pg_catalog.jsonb_build_array(
         index_namespace.nspname,
         index_relation.relname,
         table_namespace.nspname,
         table_relation.relname,
         access_method.amname,
         index_row.indisunique,
         index_row.indisprimary,
         index_row.indisexclusion,
         pg_catalog.pg_get_indexdef(index_relation.oid)
       )::text
FROM pg_catalog.pg_index AS index_row
JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = index_row.indrelid
JOIN pg_catalog.pg_namespace AS table_namespace ON table_namespace.oid = table_relation.relnamespace
JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
WHERE index_relation.relkind = 'i'
  AND table_relation.relpersistence <> 't'
  AND index_namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
  AND index_namespace.nspname <> 'information_schema'
ORDER BY index_namespace.nspname, index_relation.relname;
SQL
  chmod 0600 "$canonical_manifest"
  manifest_count="$(awk 'END { print NR + 0 }' "$canonical_manifest")"
  sha256_file "$canonical_manifest"
  printf '%s\t%s' "$manifest_count" "$REPLY"
}

assert_simple_inventory_names() {
  local unsafe_identifier_count
  unsafe_identifier_count="$(readonly_scalar "
SELECT count(*)
FROM pg_catalog.pg_index AS index_row
JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = index_row.indrelid
JOIN pg_catalog.pg_namespace AS table_namespace ON table_namespace.oid = table_relation.relnamespace
WHERE index_relation.relkind IN ('i', 'I')
  AND table_relation.relpersistence <> 't'
  AND index_namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
  AND index_namespace.nspname <> 'information_schema'
  AND (index_namespace.nspname !~ '^[A-Za-z_][A-Za-z0-9_]*$'
       OR index_relation.relname !~ '^[A-Za-z_][A-Za-z0-9_]*$'
       OR table_namespace.nspname !~ '^[A-Za-z_][A-Za-z0-9_]*$'
       OR table_relation.relname !~ '^[A-Za-z_][A-Za-z0-9_]*$');")"
  [[ "$unsafe_identifier_count" == '0' ]] ||
    fail 'user index inventory contains an identifier that cannot be serialized safely'
}

named_collation_snapshot() {
  local canonical_manifest="$CREDENTIALS_DIRECTORY/current-collation-manifest.jsonl"
  local mismatch_count dependency_count
  run_readonly -Atq -o "$canonical_manifest" <<'SQL'
WITH mismatched AS (
  SELECT collation_row.oid,
         collation_namespace.nspname AS collation_schema,
         collation_row.collname AS collation_name,
         collation_row.collversion AS recorded_version,
         pg_catalog.pg_collation_actual_version(collation_row.oid) AS actual_version
  FROM pg_catalog.pg_collation AS collation_row
  JOIN pg_catalog.pg_namespace AS collation_namespace
    ON collation_namespace.oid = collation_row.collnamespace
  WHERE collation_row.collversion IS NOT NULL
    AND pg_catalog.pg_collation_actual_version(collation_row.oid) IS NOT NULL
    AND collation_row.collversion <> pg_catalog.pg_collation_actual_version(collation_row.oid)
)
SELECT pg_catalog.jsonb_build_array(
         mismatched.collation_schema,
         mismatched.collation_name,
         mismatched.recorded_version,
         mismatched.actual_version
       )::text
FROM mismatched
ORDER BY mismatched.collation_schema, mismatched.collation_name;
SQL
  chmod 0600 "$canonical_manifest"
  mismatch_count="$(awk 'END { print NR + 0 }' "$canonical_manifest")"
  sha256_file "$canonical_manifest"
  dependency_count="$(readonly_scalar "
WITH mismatched AS (
  SELECT collation_row.oid
  FROM pg_catalog.pg_collation AS collation_row
  WHERE collation_row.collversion IS NOT NULL
    AND pg_catalog.pg_collation_actual_version(collation_row.oid) IS NOT NULL
    AND collation_row.collversion <> pg_catalog.pg_collation_actual_version(collation_row.oid)
)
SELECT count(dependency.objid)
FROM mismatched
LEFT JOIN pg_catalog.pg_depend AS dependency
  ON dependency.refclassid = 'pg_catalog.pg_collation'::pg_catalog.regclass
 AND dependency.refobjid = mismatched.oid;")"
  printf '%s\t%s\t%s' "$mismatch_count" "$REPLY" "$dependency_count"
}

postgis_status_snapshot() {
  local postgis_installed extension_snapshot postgis_extension_version postgis_default_version
  local topology_extension_version tiger_extension_version postgis_full_version normalized_full_version
  local postgis_needs_upgrade full_version_file full_version_sha256
  postgis_installed="$(readonly_scalar "
SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'postgis');")"
  if [[ "$postgis_installed" != 't' ]]; then
    printf 'false\tNONE\tNONE\tfalse\tNONE\tNONE\tNONE'
    return 0
  fi
  extension_snapshot="$(run_readonly -Atq -F $'\t' <<'SQL'
SELECT extension_row.extversion,
       coalesce(available_extension.default_version, ''),
       coalesce((SELECT candidate.extversion
                 FROM pg_catalog.pg_extension AS candidate
                 WHERE candidate.extname = 'postgis_topology'), 'NONE'),
       coalesce((SELECT candidate.extversion
                 FROM pg_catalog.pg_extension AS candidate
                 WHERE candidate.extname = 'postgis_tiger_geocoder'), 'NONE')
FROM pg_catalog.pg_extension AS extension_row
LEFT JOIN pg_catalog.pg_available_extensions AS available_extension
  ON available_extension.name = extension_row.extname
WHERE extension_row.extname = 'postgis';
SQL
  )"
  IFS=$'\t' read -r postgis_extension_version postgis_default_version \
    topology_extension_version tiger_extension_version <<<"$extension_snapshot"
  postgis_full_version="$(readonly_scalar 'SELECT public.postgis_full_version();')"
  normalized_full_version="$(printf '%s' "$postgis_full_version" | tr '[:upper:]' '[:lower:]')"
  postgis_needs_upgrade=false
  [[ "$normalized_full_version" != *'need upgrade'* ]] || postgis_needs_upgrade=true
  full_version_file="$CREDENTIALS_DIRECTORY/current-postgis-full-version.txt"
  printf '%s' "$postgis_full_version" >"$full_version_file"
  chmod 0600 "$full_version_file"
  sha256_file "$full_version_file"
  full_version_sha256="$REPLY"
  printf 'true\t%s\t%s\t%s\t%s\t%s\t%s' \
    "$postgis_extension_version" "$postgis_default_version" "$postgis_needs_upgrade" \
    "$full_version_sha256" "$topology_extension_version" "$tiger_extension_version"
}

amcheck_extension_snapshot() {
  run_readonly -Atq -F $'\t' <<'SQL'
SELECT coalesce(extension_row.extversion, 'NONE'),
       coalesce(available_extension.default_version, 'NONE'),
       coalesce(extension_namespace.nspname, 'NONE')
FROM (VALUES (1)) AS singleton(ignore)
LEFT JOIN pg_catalog.pg_extension AS extension_row ON extension_row.extname = 'amcheck'
LEFT JOIN pg_catalog.pg_available_extensions AS available_extension
  ON available_extension.name = 'amcheck'
LEFT JOIN pg_catalog.pg_namespace AS extension_namespace
  ON extension_namespace.oid = extension_row.extnamespace;
SQL
}

write_named_collation_inventory() {
  local output_file="$1"
  run_readonly --csv -q -o "$output_file" <<'SQL'
WITH mismatched AS (
  SELECT collation_row.oid,
         collation_namespace.nspname AS collation_schema,
         collation_row.collname AS collation_name,
         collation_row.collversion AS recorded_version,
         pg_catalog.pg_collation_actual_version(collation_row.oid) AS actual_version
  FROM pg_catalog.pg_collation AS collation_row
  JOIN pg_catalog.pg_namespace AS collation_namespace
    ON collation_namespace.oid = collation_row.collnamespace
  WHERE collation_row.collversion IS NOT NULL
    AND pg_catalog.pg_collation_actual_version(collation_row.oid) IS NOT NULL
    AND collation_row.collversion <> pg_catalog.pg_collation_actual_version(collation_row.oid)
)
SELECT mismatched.collation_schema,
       mismatched.collation_name,
       mismatched.recorded_version,
       mismatched.actual_version,
       count(dependency.objid) AS dependent_object_count
FROM mismatched
LEFT JOIN pg_catalog.pg_depend AS dependency
  ON dependency.refclassid = 'pg_catalog.pg_collation'::pg_catalog.regclass
 AND dependency.refobjid = mismatched.oid
GROUP BY mismatched.oid, mismatched.collation_schema, mismatched.collation_name,
         mismatched.recorded_version, mismatched.actual_version
ORDER BY mismatched.collation_schema, mismatched.collation_name;
SQL
}

index_health_snapshot() {
  run_readonly -Atq -F $'\t' <<'SQL'
SELECT count(*) FILTER (WHERE NOT index_row.indisvalid
                              OR NOT index_row.indisready
                              OR NOT index_row.indislive),
       count(*) FILTER (WHERE index_row.indisexclusion),
       count(*) FILTER (WHERE index_relation.relkind = 'I'),
       count(*) FILTER (WHERE index_relation.relname ~ '_cc(new|old)[0-9]*$')
FROM pg_catalog.pg_index AS index_row
JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
WHERE index_namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
  AND index_namespace.nspname <> 'information_schema';
SQL
}

assert_index_health() {
  local health_snapshot invalid_count exclusion_count partitioned_count concurrent_artifact_count
  health_snapshot="$(index_health_snapshot)"
  IFS=$'\t' read -r invalid_count exclusion_count partitioned_count concurrent_artifact_count \
    <<<"$health_snapshot"
  [[ "$invalid_count" == '0' ]] ||
    fail "$invalid_count user indexes are invalid/not-ready/not-live; inspect them before retrying"
  [[ "$exclusion_count" == '0' ]] ||
    fail "$exclusion_count exclusion indexes require a separately rehearsed non-concurrent rebuild"
  [[ "$partitioned_count" == '0' ]] ||
    fail "$partitioned_count partitioned indexes require an explicit leaf-index repair plan"
  [[ "$concurrent_artifact_count" == '0' ]] ||
    fail "$concurrent_artifact_count _ccnew/_ccold indexes need explicit operator review; this tool never drops them"
}

assert_database_mismatch() {
  local snapshot version_number database_name system_identifier database_collate database_ctype
  local locale_provider recorded_version actual_version current_role is_superuser checksums
  local max_connections reserved_connections
  snapshot="$(cluster_snapshot)"
  IFS=$'\t' read -r version_number database_name system_identifier database_collate database_ctype \
    locale_provider recorded_version actual_version current_role is_superuser checksums \
    max_connections reserved_connections <<<"$snapshot"
  [[ "$database_name" == "$EXPECTED_DATABASE" ]] ||
    fail "connected database is $database_name, expected $EXPECTED_DATABASE"
  [[ "$system_identifier" == "$EXPECTED_SYSTEM_IDENTIFIER" ]] ||
    fail "cluster system identifier is $system_identifier, expected $EXPECTED_SYSTEM_IDENTIFIER"
  [[ "$version_number" -ge "$((EXPECTED_SOURCE_MAJOR * 10000))" &&
     "$version_number" -lt "$(((EXPECTED_SOURCE_MAJOR + 1) * 10000))" ]] ||
    fail "server_version_num is $version_number, expected PostgreSQL $EXPECTED_SOURCE_MAJOR"
  [[ -n "$recorded_version" && -n "$actual_version" ]] ||
    fail 'database collation provider does not expose comparable version metadata'
  [[ "$recorded_version" != "$actual_version" ]] ||
    fail "database collation version already matches $actual_version; no repair is needed"
  [[ "$current_role" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    fail 'current role cannot be serialized safely in repair state'
  [[ "$is_superuser" == 't' ]] ||
    fail 'the direct repair role must be a PostgreSQL superuser'
  printf '%s' "$snapshot"
}

assert_state_identity() {
  local state_directory="$1" snapshot version_number database_name system_identifier database_collate
  local database_ctype locale_provider recorded_version actual_version current_role is_superuser checksums
  local max_connections reserved_connections manifest_snapshot_value manifest_count manifest_sha256
  local named_snapshot named_count named_sha256 named_dependency_count
  local postgis_snapshot postgis_installed postgis_extension_version postgis_default_version
  local postgis_needs_upgrade postgis_full_version_sha256 topology_extension_version
  local tiger_extension_version expected_manifest_sha256 expected_named_sha256
  local amcheck_snapshot amcheck_extension_version amcheck_default_version amcheck_schema
  local database_refresh_started=false named_refresh_started=false
  snapshot="$(cluster_snapshot)"
  IFS=$'\t' read -r version_number database_name system_identifier database_collate database_ctype \
    locale_provider recorded_version actual_version current_role is_superuser checksums \
    max_connections reserved_connections <<<"$snapshot"
  [[ "$database_name" == "$EXPECTED_DATABASE" ]] ||
    fail "connected database is $database_name, expected $EXPECTED_DATABASE"
  [[ "$system_identifier" == "$EXPECTED_SYSTEM_IDENTIFIER" ]] ||
    fail "cluster system identifier is $system_identifier, expected $EXPECTED_SYSTEM_IDENTIFIER"
  [[ "$system_identifier" == "$(metadata_value "$state_directory" system_identifier)" ]] ||
    fail 'cluster system identifier changed after audit'
  [[ "$version_number" == "$(metadata_value "$state_directory" server_version_num)" ]] ||
    fail 'PostgreSQL server version changed after audit'
  [[ "$database_collate" == "$(metadata_value "$state_directory" database_collate)" &&
     "$database_ctype" == "$(metadata_value "$state_directory" database_ctype)" &&
     "$locale_provider" == "$(metadata_value "$state_directory" locale_provider)" ]] ||
    fail 'database locale identity changed after audit'
  [[ "$checksums" == "$(metadata_value "$state_directory" data_checksums)" ]] ||
    fail 'database checksum setting changed after audit'
  [[ "$current_role" == "$(metadata_value "$state_directory" audit_role)" ]] ||
    fail 'direct repair role changed after audit'
  [[ "$is_superuser" == 't' && "$(metadata_value "$state_directory" audit_role_superuser)" == 't' ]] ||
    fail 'the direct repair role must remain a PostgreSQL superuser'
  assert_no_replication_objects
  expected_manifest_sha256="$(metadata_value "$state_directory" index_manifest_sha256)"
  if state_marker_matches "$state_directory" collation-refresh.started "$expected_manifest_sha256"; then
    database_refresh_started=true
  fi
  if state_marker_matches "$state_directory" collation-refresh.complete "$expected_manifest_sha256"; then
    [[ "$recorded_version" == "$actual_version" &&
       "$actual_version" == "$(metadata_value "$state_directory" actual_collation_version)" ]] ||
      fail 'database collation version changed unexpectedly after refresh'
  elif [[ "$recorded_version" == "$(metadata_value "$state_directory" recorded_collation_version)" &&
          "$recorded_version" != "$actual_version" ]]; then
    :
  elif [[ "$database_refresh_started" == 'true' && "$recorded_version" == "$actual_version" &&
          "$actual_version" == "$(metadata_value "$state_directory" actual_collation_version)" ]]; then
    :
  else
    fail 'database collation version changed outside a resumable repair operation'
  fi
  [[ "$actual_version" == "$(metadata_value "$state_directory" actual_collation_version)" ]] ||
    fail 'operating-system collation version changed after audit'
  manifest_snapshot_value="$(manifest_snapshot)"
  IFS=$'\t' read -r manifest_count manifest_sha256 <<<"$manifest_snapshot_value"
  [[ "$manifest_count" == "$(metadata_value "$state_directory" index_count)" ]] ||
    fail 'user-index count changed after audit'
  [[ "$manifest_sha256" == "$(metadata_value "$state_directory" index_manifest_sha256)" ]] ||
    fail 'user-index definitions changed after audit'
  named_snapshot="$(named_collation_snapshot)"
  IFS=$'\t' read -r named_count named_sha256 named_dependency_count <<<"$named_snapshot"
  [[ "$(metadata_value "$state_directory" named_collation_dependency_count)" == '0' ]] ||
    fail 'the audit found dependent objects using mismatched named collations'
  expected_named_sha256="$(metadata_value "$state_directory" named_collation_manifest_sha256)"
  if state_marker_matches "$state_directory" named-collations-refresh.started "$expected_named_sha256"; then
    named_refresh_started=true
  fi
  [[ "$named_dependency_count" == '0' ]] ||
    fail 'a dependent object began using a mismatched named collation after audit'
  if state_marker_matches "$state_directory" named-collations-refresh.complete "$expected_named_sha256"; then
    [[ "$named_count" == '0' ]] ||
      fail 'named collations are mismatched after their refresh marker was written'
  elif [[ "$named_count" == "$(metadata_value "$state_directory" named_collation_mismatch_count)" &&
          "$named_sha256" == "$expected_named_sha256" && "$named_dependency_count" == '0' ]]; then
    :
  elif [[ "$named_refresh_started" == 'true' && "$named_count" == '0' &&
          "$named_dependency_count" == '0' ]]; then
    :
  else
    fail 'named-collation mismatch definitions changed outside a resumable repair operation'
  fi
  postgis_snapshot="$(postgis_status_snapshot)"
  IFS=$'\t' read -r postgis_installed postgis_extension_version postgis_default_version \
    postgis_needs_upgrade postgis_full_version_sha256 topology_extension_version \
    tiger_extension_version <<<"$postgis_snapshot"
  [[ "$postgis_installed" == "$(metadata_value "$state_directory" postgis_installed)" &&
     "$postgis_extension_version" == "$(metadata_value "$state_directory" postgis_extension_version)" &&
     "$postgis_default_version" == "$(metadata_value "$state_directory" postgis_default_version)" &&
     "$postgis_needs_upgrade" == "$(metadata_value "$state_directory" postgis_catalog_needs_upgrade)" &&
     "$postgis_full_version_sha256" == "$(metadata_value "$state_directory" postgis_full_version_sha256)" &&
     "$topology_extension_version" == "$(metadata_value "$state_directory" postgis_topology_extension_version)" &&
     "$tiger_extension_version" == "$(metadata_value "$state_directory" postgis_tiger_geocoder_extension_version)" ]] ||
    fail 'PostGIS extension/runtime status changed after audit'
  amcheck_snapshot="$(amcheck_extension_snapshot)"
  IFS=$'\t' read -r amcheck_extension_version amcheck_default_version amcheck_schema \
    <<<"$amcheck_snapshot"
  [[ "$amcheck_extension_version" == "$(metadata_value "$state_directory" amcheck_extension_version)" &&
     "$amcheck_default_version" == "$(metadata_value "$state_directory" amcheck_default_version)" &&
     "$amcheck_schema" == "$(metadata_value "$state_directory" amcheck_schema)" ]] ||
    fail 'amcheck extension status changed after audit'
  assert_index_health
}

assert_repair_acknowledgements() {
  local state_directory="$1" expected_token expected_system_identifier source_image_reference
  local containment_evidence_sha256
  expected_token="$(metadata_value "$state_directory" repair_ack)"
  expected_system_identifier="$(metadata_value "$state_directory" system_identifier)"
  source_image_reference="$(metadata_value "$state_directory" source_image_reference)"
  [[ "$source_image_reference" =~ ^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}$ ]] ||
    fail 'audit did not attest an immutable source image reference'
  [[ "$(metadata_value "$state_directory" source_image_pin_confirmed)" == 'true' ]] ||
    fail 'audit did not confirm Railway was deployed from the immutable source image pin'
  [[ "$(metadata_value "$state_directory" connection_containment_verified)" == 'true' ]] ||
    fail 'audit did not confirm PgBouncer, restricted roles, and the 24-hour connection soak'
  containment_evidence_sha256="$(metadata_value "$state_directory" connection_containment_evidence_sha256)"
  [[ "$containment_evidence_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'audit did not bind a connection-containment evidence bundle'
  [[ "$CONNECTION_CONTAINMENT_EVIDENCE_SHA256" == "$containment_evidence_sha256" ]] ||
    fail "CONNECTION_CONTAINMENT_EVIDENCE_SHA256 must exactly equal $containment_evidence_sha256"
  [[ "$(metadata_value "$state_directory" postgis_catalog_needs_upgrade)" == 'false' ]] ||
    fail 'audit found PostGIS extension SQL objects that need upgrade; repair the restored clone and source, then take a new audit'
  [[ "$(metadata_value "$state_directory" postgis_installed)" == 'true' ]] ||
    fail 'audit did not find PostGIS on the production repair target'
  [[ "$(metadata_value "$state_directory" amcheck_extension_version)" != 'NONE' &&
     "$(metadata_value "$state_directory" amcheck_schema)" != 'NONE' ]] ||
    fail 'audit did not find the amcheck extension installed before system reindexing'
  [[ "$(metadata_value "$state_directory" reindex_maintenance_work_mem)" == \
     "$REINDEX_MAINTENANCE_WORK_MEM" &&
     "$(metadata_value "$state_directory" reindex_max_parallel_maintenance_workers)" == \
     "$REINDEX_MAX_PARALLEL_MAINTENANCE_WORKERS" ]] ||
    fail 'repair maintenance-memory or parallel-worker settings changed after audit'
  [[ "${COLLATION_REPAIR_ACK:-}" == "$expected_token" ]] ||
    fail "COLLATION_REPAIR_ACK must exactly equal $expected_token"
  [[ "${EXPECTED_SYSTEM_IDENTIFIER:-}" == "$expected_system_identifier" ]] ||
    fail "EXPECTED_SYSTEM_IDENTIFIER must exactly equal $expected_system_identifier"
  [[ "${BACKUP_RESTORE_VERIFIED:-}" == 'true' ]] ||
    fail 'BACKUP_RESTORE_VERIFIED=true is required after a successful portable restore'
  [[ "${RESTORED_CLONE_AMCHECK_VERIFIED:-}" == 'true' ]] ||
    fail 'RESTORED_CLONE_AMCHECK_VERIFIED=true is required after clone pg_amcheck and app probes'
}

live_gate_snapshot() {
  run_readonly -Atq -F $'\t' <<'SQL'
WITH settings AS (
  SELECT current_setting('max_connections')::integer AS max_connections,
         current_setting('superuser_reserved_connections')::integer AS reserved_connections
), activity AS (
  SELECT count(*) FILTER (WHERE backend_type = 'client backend') AS client_count,
         coalesce(max(extract(epoch FROM clock_timestamp() - xact_start))
                    FILTER (WHERE backend_type = 'client backend' AND xact_start IS NOT NULL), -1) AS oldest_xact,
         coalesce(max(extract(epoch FROM clock_timestamp() - state_change))
                    FILTER (WHERE backend_type = 'client backend'
                              AND state = 'idle in transaction'), -1) AS oldest_idle_xact
  FROM pg_catalog.pg_stat_activity
  WHERE pid <> pg_catalog.pg_backend_pid()
), replication AS (
  SELECT (SELECT count(*) FROM pg_catalog.pg_publication)
       + (SELECT count(*) FROM pg_catalog.pg_subscription)
       + (SELECT count(*) FROM pg_catalog.pg_replication_slots) AS replication_object_count
)
SELECT activity.client_count,
       settings.max_connections,
       settings.reserved_connections,
       floor(activity.oldest_xact)::bigint,
       floor(activity.oldest_idle_xact)::bigint,
       replication.replication_object_count
FROM settings CROSS JOIN activity CROSS JOIN replication;
SQL
}

assert_live_database_gates() {
  local gate_snapshot client_count max_connections reserved_connections oldest_xact oldest_idle_xact
  local replication_object_count usable_connections free_connections
  gate_snapshot="$(live_gate_snapshot)"
  IFS=$'\t' read -r client_count max_connections reserved_connections oldest_xact oldest_idle_xact \
    replication_object_count <<<"$gate_snapshot"
  usable_connections=$((max_connections - reserved_connections))
  free_connections=$((usable_connections - client_count))
  [[ "$free_connections" -ge "$MIN_FREE_CONNECTIONS" ]] ||
    fail "only $free_connections ordinary connection slots are free; require at least $MIN_FREE_CONNECTIONS"
  [[ "$((client_count * 100))" -lt "$((usable_connections * MAX_CONNECTION_PERCENT))" ]] ||
    fail "$client_count/$usable_connections ordinary connections are in use; require less than ${MAX_CONNECTION_PERCENT}%"
  [[ "$oldest_xact" -le "$MAX_TRANSACTION_AGE_SECONDS" ]] ||
    fail "oldest transaction is ${oldest_xact}s; limit is ${MAX_TRANSACTION_AGE_SECONDS}s"
  [[ "$oldest_idle_xact" -le "$MAX_IDLE_TRANSACTION_AGE_SECONDS" ]] ||
    fail "oldest idle transaction is ${oldest_idle_xact}s; limit is ${MAX_IDLE_TRANSACTION_AGE_SECONDS}s"
  [[ "$replication_object_count" == '0' ]] ||
    fail 'collation repair must finish before publications, subscriptions, or replication slots exist'
}

assert_external_resource_gates() {
  local largest_index_bytes="$1" current_epoch sample_age memory_free_bytes disk_required_bytes
  local disk_used_bytes projected_disk_bytes
  require_integer RESOURCE_SAMPLE_EPOCH "${RESOURCE_SAMPLE_EPOCH:-}"
  require_decimal RESOURCE_CPU_PERCENT_15M "${RESOURCE_CPU_PERCENT_15M:-}"
  require_integer RESOURCE_MEMORY_BYTES "${RESOURCE_MEMORY_BYTES:-}"
  require_positive_integer RESOURCE_MEMORY_LIMIT_BYTES "${RESOURCE_MEMORY_LIMIT_BYTES:-}"
  require_integer RESOURCE_DISK_FREE_BYTES "${RESOURCE_DISK_FREE_BYTES:-}"
  require_positive_integer RESOURCE_DISK_CAPACITY_BYTES "${RESOURCE_DISK_CAPACITY_BYTES:-}"
  current_epoch="$(date +%s)"
  sample_age=$((current_epoch - RESOURCE_SAMPLE_EPOCH))
  [[ "$sample_age" -ge -60 && "$sample_age" -le "$RESOURCE_SAMPLE_MAX_AGE_SECONDS" ]] ||
    fail "Railway resource sample is ${sample_age}s old; require a fresh sample"
  decimal_less_than "$RESOURCE_CPU_PERCENT_15M" "$MAX_CPU_PERCENT_15M" ||
    fail "15-minute CPU is ${RESOURCE_CPU_PERCENT_15M}%; require less than ${MAX_CPU_PERCENT_15M}%"
  [[ "$RESOURCE_MEMORY_BYTES" -lt "$RESOURCE_MEMORY_LIMIT_BYTES" ]] ||
    fail 'memory usage is not below the Railway memory limit'
  [[ "$((RESOURCE_MEMORY_BYTES * 100))" -lt "$((RESOURCE_MEMORY_LIMIT_BYTES * MAX_MEMORY_PERCENT))" ]] ||
    fail "memory usage must be below ${MAX_MEMORY_PERCENT}%"
  memory_free_bytes=$((RESOURCE_MEMORY_LIMIT_BYTES - RESOURCE_MEMORY_BYTES))
  [[ "$memory_free_bytes" -ge "$MIN_MEMORY_FREE_BYTES" ]] ||
    fail "memory headroom is $memory_free_bytes bytes; require at least $MIN_MEMORY_FREE_BYTES"
  [[ "$RESOURCE_DISK_FREE_BYTES" -le "$RESOURCE_DISK_CAPACITY_BYTES" ]] ||
    fail 'disk free bytes exceed disk capacity'
  disk_required_bytes=$((largest_index_bytes * 3 + MIN_DISK_FREE_BASE_BYTES))
  [[ "$RESOURCE_DISK_FREE_BYTES" -ge "$disk_required_bytes" ]] ||
    fail "disk headroom is $RESOURCE_DISK_FREE_BYTES bytes; require $disk_required_bytes"
  disk_used_bytes=$((RESOURCE_DISK_CAPACITY_BYTES - RESOURCE_DISK_FREE_BYTES))
  projected_disk_bytes=$((disk_used_bytes + largest_index_bytes * 3))
  [[ "$((projected_disk_bytes * 100))" -lt "$((RESOURCE_DISK_CAPACITY_BYTES * MAX_PROJECTED_DISK_PERCENT))" ]] ||
    fail "projected repair disk use must remain below ${MAX_PROJECTED_DISK_PERCENT}%"
}

assert_maintenance_fence() {
  local state_directory="$1" maintenance_token other_client_count
  maintenance_token="$(metadata_value "$state_directory" maintenance_ack)"
  [[ "${WRITES_FENCED:-}" == 'true' ]] || fail 'WRITES_FENCED=true is required'
  [[ "${CLIENTS_FENCED:-}" == 'true' ]] || fail 'CLIENTS_FENCED=true is required'
  [[ "${MAINTENANCE_WINDOW_ACK:-}" == "$maintenance_token" ]] ||
    fail "MAINTENANCE_WINDOW_ACK must exactly equal $maintenance_token"
  other_client_count="$(readonly_scalar "
SELECT count(*)
FROM pg_catalog.pg_stat_activity
WHERE pid <> pg_catalog.pg_backend_pid()
  AND backend_type = 'client backend';")"
  [[ "$other_client_count" == '0' ]] ||
    fail "$other_client_count cluster-wide client backends remain connected after the client fence"
}

write_audit_state() {
  local state_directory="$1" snapshot version_number database_name system_identifier database_collate
  local database_ctype locale_provider recorded_version actual_version current_role is_superuser checksums
  local max_connections reserved_connections health_snapshot invalid_count exclusion_count partitioned_count
  local concurrent_artifact_count named_snapshot named_mismatch_count named_manifest_sha256
  local named_dependency_count manifest_snapshot_value index_count manifest_sha256
  local postgis_snapshot postgis_installed postgis_extension_version postgis_default_version
  local postgis_needs_upgrade postgis_full_version_sha256 topology_extension_version
  local tiger_extension_version largest_index_bytes repair_ack maintenance_ack
  local index_inventory_sha256
  local amcheck_snapshot amcheck_extension_version amcheck_default_version amcheck_schema
  [[ ! -e "$state_directory" ]] || fail "audit state path already exists: $state_directory"
  [[ "$SOURCE_IMAGE_REFERENCE" == 'UNVERIFIED' ||
     "$SOURCE_IMAGE_REFERENCE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}$ ]] ||
    fail 'SOURCE_IMAGE_REFERENCE must be UNVERIFIED or an immutable image@sha256:<64 hex> reference'
  if [[ "$CONNECTION_CONTAINMENT_VERIFIED" == 'true' ]]; then
    [[ "$CONNECTION_CONTAINMENT_EVIDENCE_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
      fail 'verified connection containment requires its evidence SHA-256'
  fi
  snapshot="$(assert_database_mismatch)"
  IFS=$'\t' read -r version_number database_name system_identifier database_collate database_ctype \
    locale_provider recorded_version actual_version current_role is_superuser checksums \
    max_connections reserved_connections <<<"$snapshot"
  assert_no_replication_objects
  assert_simple_inventory_names
  health_snapshot="$(index_health_snapshot)"
  IFS=$'\t' read -r invalid_count exclusion_count partitioned_count concurrent_artifact_count \
    <<<"$health_snapshot"
  named_snapshot="$(named_collation_snapshot)"
  IFS=$'\t' read -r named_mismatch_count named_manifest_sha256 named_dependency_count \
    <<<"$named_snapshot"
  manifest_snapshot_value="$(manifest_snapshot)"
  IFS=$'\t' read -r index_count manifest_sha256 <<<"$manifest_snapshot_value"
  postgis_snapshot="$(postgis_status_snapshot)"
  IFS=$'\t' read -r postgis_installed postgis_extension_version postgis_default_version \
    postgis_needs_upgrade postgis_full_version_sha256 topology_extension_version \
    tiger_extension_version <<<"$postgis_snapshot"
  amcheck_snapshot="$(amcheck_extension_snapshot)"
  IFS=$'\t' read -r amcheck_extension_version amcheck_default_version amcheck_schema \
    <<<"$amcheck_snapshot"
  repair_ack="repair:${system_identifier}:${recorded_version}-to-${actual_version}:${manifest_sha256}"
  maintenance_ack="maintenance:${system_identifier}:${manifest_sha256}"

  mkdir -m 0700 -- "$state_directory"
  printf '%s\n' 'boardsesh-postgres16-collation-repair-v3' >"$state_directory/format"
  run_readonly -Atq -F $'\t' -c "$(index_inventory_sql)" >"$state_directory/indexes.tsv"
  sha256_file "$state_directory/indexes.tsv"
  index_inventory_sha256="$REPLY"
  write_named_collation_inventory "$state_directory/collations.csv"
  : >"$state_directory/completed-indexes.txt"
  largest_index_bytes="$(awk -F '\t' 'NR == 1 { print $5 }' "$state_directory/indexes.tsv")"
  largest_index_bytes="${largest_index_bytes:-0}"
  {
    printf 'server_version_num\t%s\n' "$version_number"
    printf 'database\t%s\n' "$database_name"
    printf 'system_identifier\t%s\n' "$system_identifier"
    printf 'database_collate\t%s\n' "$database_collate"
    printf 'database_ctype\t%s\n' "$database_ctype"
    printf 'locale_provider\t%s\n' "$locale_provider"
    printf 'recorded_collation_version\t%s\n' "$recorded_version"
    printf 'actual_collation_version\t%s\n' "$actual_version"
    printf 'audit_role\t%s\n' "$current_role"
    printf 'audit_role_superuser\t%s\n' "$is_superuser"
    printf 'data_checksums\t%s\n' "$checksums"
    printf 'max_connections\t%s\n' "$max_connections"
    printf 'superuser_reserved_connections\t%s\n' "$reserved_connections"
    printf 'source_image_reference\t%s\n' "$SOURCE_IMAGE_REFERENCE"
    printf 'source_image_pin_confirmed\t%s\n' "$SOURCE_IMAGE_PIN_CONFIRMED"
    printf 'connection_containment_verified\t%s\n' "$CONNECTION_CONTAINMENT_VERIFIED"
    printf 'connection_containment_evidence_sha256\t%s\n' \
      "$CONNECTION_CONTAINMENT_EVIDENCE_SHA256"
    printf 'index_count\t%s\n' "$index_count"
    printf 'index_manifest_sha256\t%s\n' "$manifest_sha256"
    printf 'index_inventory_sha256\t%s\n' "$index_inventory_sha256"
    printf 'largest_index_bytes\t%s\n' "$largest_index_bytes"
    printf 'invalid_index_count\t%s\n' "$invalid_count"
    printf 'exclusion_index_count\t%s\n' "$exclusion_count"
    printf 'partitioned_index_count\t%s\n' "$partitioned_count"
    printf 'concurrent_artifact_count\t%s\n' "$concurrent_artifact_count"
    printf 'named_collation_mismatch_count\t%s\n' "$named_mismatch_count"
    printf 'named_collation_manifest_sha256\t%s\n' "$named_manifest_sha256"
    printf 'named_collation_dependency_count\t%s\n' "$named_dependency_count"
    printf 'postgis_installed\t%s\n' "$postgis_installed"
    printf 'postgis_extension_version\t%s\n' "$postgis_extension_version"
    printf 'postgis_default_version\t%s\n' "$postgis_default_version"
    printf 'postgis_catalog_needs_upgrade\t%s\n' "$postgis_needs_upgrade"
    printf 'postgis_full_version_sha256\t%s\n' "$postgis_full_version_sha256"
    printf 'postgis_topology_extension_version\t%s\n' "$topology_extension_version"
    printf 'postgis_tiger_geocoder_extension_version\t%s\n' "$tiger_extension_version"
    printf 'amcheck_extension_version\t%s\n' "$amcheck_extension_version"
    printf 'amcheck_default_version\t%s\n' "$amcheck_default_version"
    printf 'amcheck_schema\t%s\n' "$amcheck_schema"
    printf 'reindex_maintenance_work_mem\t%s\n' "$REINDEX_MAINTENANCE_WORK_MEM"
    printf 'reindex_max_parallel_maintenance_workers\t%s\n' \
      "$REINDEX_MAX_PARALLEL_MAINTENANCE_WORKERS"
    printf 'repair_ack\t%s\n' "$repair_ack"
    printf 'maintenance_ack\t%s\n' "$maintenance_ack"
  } >"$state_directory/metadata.tsv"
  chmod 0600 "$state_directory"/*
  assert_state_inventory "$state_directory"

  printf 'Audit captured for PostgreSQL %s database %s, system identifier %s.\n' \
    "$version_number" "$database_name" "$system_identifier"
  printf 'Database collation mismatch: %s -> %s (%s / %s, provider %s).\n' \
    "$recorded_version" "$actual_version" "$database_collate" "$database_ctype" "$locale_provider"
  printf 'Full user-index manifest: %s indexes, largest %s bytes, SHA-256 %s.\n' \
    "$index_count" "$largest_index_bytes" "$manifest_sha256"
  printf 'Audit blockers: invalid=%s exclusion=%s partitioned=%s concurrent-artifacts=%s named-collation-dependencies=%s.\n' \
    "$invalid_count" "$exclusion_count" "$partitioned_count" "$concurrent_artifact_count" \
    "$named_dependency_count"
  printf 'Dependency-free named collations queued for final refresh: %s (SHA-256 %s).\n' \
    "$named_mismatch_count" "$named_manifest_sha256"
  printf 'PostGIS catalog: installed=%s extension=%s available-default=%s needs-upgrade=%s.\n' \
    "$postgis_installed" "$postgis_extension_version" "$postgis_default_version" \
    "$postgis_needs_upgrade"
  printf 'amcheck extension: installed=%s available-default=%s schema=%s.\n' \
    "$amcheck_extension_version" "$amcheck_default_version" "$amcheck_schema"
  printf 'COLLATION_REPAIR_ACK=%s\n' "$repair_ack"
  printf 'EXPECTED_SYSTEM_IDENTIFIER=%s\n' "$system_identifier"
  printf 'MAINTENANCE_WINDOW_ACK=%s\n' "$maintenance_ack"
}

completed_count() {
  local state_directory="$1"
  awk 'NF { count += 1 } END { print count + 0 }' "$state_directory/completed-indexes.txt"
}

assert_completion_journal() {
  local state_directory="$1"
  awk -F '\t' '
    NR == FNR { allowed[$1 "." $2] = 1; next }
    NF == 0 { next }
    !allowed[$0] { exit 1 }
    seen[$0]++ { exit 1 }
  ' "$state_directory/indexes.tsv" "$state_directory/completed-indexes.txt" ||
    fail 'completion journal contains an unknown or duplicate index'
}

mark_user_complete_if_done() {
  local state_directory="$1" completed expected manifest_sha256
  assert_completion_journal "$state_directory"
  completed="$(completed_count "$state_directory")"
  expected="$(metadata_value "$state_directory" index_count)"
  if [[ "$completed" == "$expected" ]]; then
    manifest_sha256="$(metadata_value "$state_directory" index_manifest_sha256)"
    if ! state_marker_matches "$state_directory" user-reindex.complete "$manifest_sha256"; then
      write_state_marker "$state_directory" user-reindex.complete "$manifest_sha256"
    fi
    return 0
  fi
  return 1
}

show_status() {
  local state_directory="$1" completed expected remaining gate_snapshot client_count max_connections
  local reserved_connections oldest_xact oldest_idle_xact replication_object_count usable_connections
  assert_completion_journal "$state_directory"
  completed="$(completed_count "$state_directory")"
  expected="$(metadata_value "$state_directory" index_count)"
  remaining=$((expected - completed))
  [[ "$remaining" -ge 0 ]] || fail 'completion journal has more entries than the audit manifest'
  printf 'User indexes: %s/%s complete; %s remaining.\n' "$completed" "$expected" "$remaining"
  if [[ -f "$state_directory/system-reindex.complete" ]]; then
    printf 'System catalogs: complete.\n'
  else
    printf 'System catalogs: pending fenced maintenance window.\n'
  fi
  if [[ -f "$state_directory/production-amcheck.tsv" ]]; then
    assert_production_amcheck_evidence "$state_directory"
    printf 'Production pg_amcheck: complete.\n'
  else
    printf 'Production pg_amcheck: pending fenced verification.\n'
  fi
  if [[ -f "$state_directory/collation-refresh.complete" ]]; then
    printf 'Collation version refresh: complete.\n'
  else
    printf 'Collation version refresh: pending validation.\n'
  fi
  gate_snapshot="$(live_gate_snapshot)"
  IFS=$'\t' read -r client_count max_connections reserved_connections oldest_xact oldest_idle_xact \
    replication_object_count <<<"$gate_snapshot"
  usable_connections=$((max_connections - reserved_connections))
  printf 'Live gate: %s/%s ordinary connections, oldest transaction %ss, oldest idle transaction %ss, replication objects %s.\n' \
    "$client_count" "$usable_connections" "$oldest_xact" "$oldest_idle_xact" \
    "$replication_object_count"
}

next_index_row() {
  local state_directory="$1" index_schema index_name table_schema table_name index_bytes index_definition_hex
  while IFS=$'\t' read -r index_schema index_name table_schema table_name index_bytes index_definition_hex; do
    [[ -n "$index_schema" ]] || continue
    if ! grep -Fxq "$index_schema.$index_name" "$state_directory/completed-indexes.txt"; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$index_schema" "$index_name" "$table_schema" \
        "$table_name" "$index_bytes" "$index_definition_hex"
      return 0
    fi
  done <"$state_directory/indexes.tsv"
  return 1
}

reindex_next() {
  local state_directory="$1" next_row index_schema index_name table_schema table_name index_bytes
  local index_definition_hex current_definition_hex current_index_bytes
  assert_repair_acknowledgements "$state_directory"
  assert_state_identity "$state_directory"
  if ! next_row="$(next_index_row "$state_directory")"; then
    mark_user_complete_if_done "$state_directory"
    printf 'Every user index in the audit manifest is already complete.\n'
    return 0
  fi
  IFS=$'\t' read -r index_schema index_name table_schema table_name index_bytes index_definition_hex \
    <<<"$next_row"
  assert_live_database_gates
  IFS=$'\t' read -r current_index_bytes current_definition_hex <<<"$(run_readonly -Atq -F $'\t' -c "
SELECT pg_catalog.pg_relation_size(index_relation.oid),
       pg_catalog.encode(
         pg_catalog.convert_to(pg_catalog.pg_get_indexdef(index_relation.oid), 'UTF8'), 'hex')
FROM pg_catalog.pg_class AS index_relation
JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
WHERE index_namespace.nspname = '$index_schema'
  AND index_relation.relname = '$index_name'
  AND index_relation.relkind = 'i';")"
  require_integer current_index_bytes "$current_index_bytes"
  [[ "$current_definition_hex" == "$index_definition_hex" ]] ||
    fail "index definition changed before rebuild: $index_schema.$index_name"
  assert_external_resource_gates "$current_index_bytes"
  printf 'Reindexing %s.%s on %s.%s (%s current bytes; %s at audit).\n' \
    "$index_schema" "$index_name" "$table_schema" "$table_name" "$current_index_bytes" \
    "$index_bytes"
  run_maintenance \
    "-c lock_timeout=${REINDEX_LOCK_TIMEOUT_MS} -c statement_timeout=${REINDEX_STATEMENT_TIMEOUT_MS} -c maintenance_work_mem=${REINDEX_MAINTENANCE_WORK_MEM} -c max_parallel_maintenance_workers=${REINDEX_MAX_PARALLEL_MAINTENANCE_WORKERS} -c application_name=boardsesh-collation-reindex" \
    -c "REINDEX (VERBOSE) INDEX CONCURRENTLY \"$index_schema\".\"$index_name\";"
  assert_index_health
  current_definition_hex="$(readonly_scalar "
SELECT pg_catalog.encode(
         pg_catalog.convert_to(pg_catalog.pg_get_indexdef(index_relation.oid), 'UTF8'), 'hex')
FROM pg_catalog.pg_class AS index_relation
JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
WHERE index_namespace.nspname = '$index_schema'
  AND index_relation.relname = '$index_name'
  AND index_relation.relkind = 'i';")"
  [[ "$current_definition_hex" == "$index_definition_hex" ]] ||
    fail "index definition changed during rebuild: $index_schema.$index_name"
  append_completion_journal "$state_directory" "$index_schema.$index_name"
  if mark_user_complete_if_done "$state_directory"; then
    printf 'All user indexes are complete. Fence clients before reindex-system.\n'
  else
    show_status "$state_directory"
  fi
}

assert_user_reindex_complete() {
  local state_directory="$1" manifest_sha256
  mark_user_complete_if_done "$state_directory" || fail 'not every user index has been rebuilt'
  manifest_sha256="$(metadata_value "$state_directory" index_manifest_sha256)"
  state_marker_matches "$state_directory" user-reindex.complete "$manifest_sha256" ||
    fail 'user-index completion marker is missing'
}

assert_system_reindex_complete() {
  local state_directory="$1" manifest_sha256
  manifest_sha256="$(metadata_value "$state_directory" index_manifest_sha256)"
  state_marker_matches "$state_directory" system-reindex.complete "$manifest_sha256" ||
    fail 'system reindex completion marker is missing'
}

reindex_system() {
  local state_directory="$1" database_name manifest_sha256
  assert_repair_acknowledgements "$state_directory"
  assert_state_identity "$state_directory"
  assert_user_reindex_complete "$state_directory"
  assert_maintenance_fence "$state_directory"
  if [[ -e "$state_directory/system-reindex.complete" ||
        -L "$state_directory/system-reindex.complete" ]]; then
    assert_system_reindex_complete "$state_directory"
    printf 'System catalog reindex evidence is already complete.\n'
    return 0
  fi
  database_name="$(metadata_value "$state_directory" database)"
  manifest_sha256="$(metadata_value "$state_directory" index_manifest_sha256)"
  printf 'Reindexing PostgreSQL system catalogs for %s with client access fenced.\n' "$database_name"
  run_maintenance \
    "-P -c lock_timeout=${REINDEX_LOCK_TIMEOUT_MS} -c statement_timeout=${SYSTEM_REINDEX_STATEMENT_TIMEOUT_MS} -c maintenance_work_mem=${REINDEX_MAINTENANCE_WORK_MEM} -c max_parallel_maintenance_workers=${REINDEX_MAX_PARALLEL_MAINTENANCE_WORKERS} -c application_name=boardsesh-collation-system-reindex" \
    -c "REINDEX (VERBOSE) SYSTEM \"$database_name\";"
  assert_state_identity "$state_directory"
  write_state_marker "$state_directory" system-reindex.complete "$manifest_sha256"
  printf 'System catalog reindex complete. Run amcheck while clients remain fenced.\n'
}

assert_production_amcheck_evidence() {
  local state_directory="$1" evidence_file transcript_file expected_options expected_server_options
  local completed_epoch
  local recorded_transcript_sha256 actual_transcript_sha256 evidence_mode transcript_mode
  local manifest_sha256 client_version
  evidence_file="$state_directory/production-amcheck.tsv"
  transcript_file="$state_directory/production-amcheck.log"
  [[ -f "$evidence_file" && ! -L "$evidence_file" ]] ||
    fail 'production pg_amcheck evidence marker is missing or is a symlink'
  [[ -f "$transcript_file" && ! -L "$transcript_file" ]] ||
    fail 'production pg_amcheck transcript is missing or is a symlink'
  evidence_mode="$(state_mode "$evidence_file")"
  transcript_mode="$(state_mode "$transcript_file")"
  [[ "$evidence_mode" =~ ^[0-7]+$ && "$transcript_mode" =~ ^[0-7]+$ ]] ||
    fail 'could not determine production pg_amcheck evidence permissions'
  (((8#$evidence_mode & 077) == 0 && (8#$transcript_mode & 077) == 0)) ||
    fail 'production pg_amcheck evidence must not be accessible by group or other users'
  manifest_sha256="$(metadata_value "$state_directory" index_manifest_sha256)"
  state_marker_matches "$state_directory" user-reindex.complete "$manifest_sha256" ||
    fail 'user-index completion marker is missing'
  state_marker_matches "$state_directory" system-reindex.complete "$manifest_sha256" ||
    fail 'system reindex completion marker is missing'
  [[ "$(tsv_value "$evidence_file" format 'production pg_amcheck evidence')" == \
     'boardsesh-postgres16-production-amcheck-v1' ]] ||
    fail 'production pg_amcheck evidence has an unsupported format'
  [[ "$(tsv_value "$evidence_file" system_identifier 'production pg_amcheck evidence')" == \
     "$(metadata_value "$state_directory" system_identifier)" ]] ||
    fail 'production pg_amcheck evidence has the wrong system identifier'
  [[ "$(tsv_value "$evidence_file" server_version_num 'production pg_amcheck evidence')" == \
     "$(metadata_value "$state_directory" server_version_num)" ]] ||
    fail 'production pg_amcheck evidence has the wrong server version'
  [[ "$(tsv_value "$evidence_file" database 'production pg_amcheck evidence')" == \
     "$(metadata_value "$state_directory" database)" ]] ||
    fail 'production pg_amcheck evidence has the wrong database'
  [[ "$(tsv_value "$evidence_file" actual_collation_version 'production pg_amcheck evidence')" == \
     "$(metadata_value "$state_directory" actual_collation_version)" ]] ||
    fail 'production pg_amcheck evidence has the wrong collation version'
  [[ "$(tsv_value "$evidence_file" index_manifest_sha256 'production pg_amcheck evidence')" == \
     "$manifest_sha256" ]] ||
    fail 'production pg_amcheck evidence has the wrong index manifest'
  [[ "$(tsv_value "$evidence_file" user_reindex_marker 'production pg_amcheck evidence')" == \
     "$manifest_sha256" ]] ||
    fail 'production pg_amcheck evidence has the wrong user-reindex marker'
  [[ "$(tsv_value "$evidence_file" system_reindex_marker 'production pg_amcheck evidence')" == \
     "$manifest_sha256" ]] ||
    fail 'production pg_amcheck evidence has the wrong system-reindex marker'
  [[ "$(tsv_value "$evidence_file" postgis_full_version_sha256 'production pg_amcheck evidence')" == \
     "$(metadata_value "$state_directory" postgis_full_version_sha256)" ]] ||
    fail 'production pg_amcheck evidence has the wrong PostGIS runtime fingerprint'
  [[ "$(tsv_value "$evidence_file" connection_containment_evidence_sha256 'production pg_amcheck evidence')" == \
     "$(metadata_value "$state_directory" connection_containment_evidence_sha256)" ]] ||
    fail 'production pg_amcheck evidence has the wrong containment evidence fingerprint'
  [[ "$(tsv_value "$evidence_file" pg_amcheck_client_major 'production pg_amcheck evidence')" == \
     "$EXPECTED_SOURCE_MAJOR" ]] ||
    fail 'production pg_amcheck evidence used the wrong client major version'
  client_version="$(tsv_value "$evidence_file" pg_amcheck_client_version \
    'production pg_amcheck evidence')"
  [[ "$client_version" =~ PostgreSQL\)\ "$EXPECTED_SOURCE_MAJOR"([.][0-9]+) ]] ||
    fail 'production pg_amcheck evidence has an invalid client version'
  expected_options='--no-password --jobs=1 --parent-check --heapallindexed --progress --verbose'
  [[ "$(tsv_value "$evidence_file" pg_amcheck_options 'production pg_amcheck evidence')" == \
     "$expected_options" ]] ||
    fail 'production pg_amcheck evidence used unexpected options'
  expected_server_options="-c lock_timeout=5000 -c statement_timeout=43200000 -c maintenance_work_mem=${REINDEX_MAINTENANCE_WORK_MEM} -c application_name=boardsesh-production-amcheck"
  [[ "$(tsv_value "$evidence_file" pg_amcheck_server_options 'production pg_amcheck evidence')" == \
     "$expected_server_options" ]] ||
    fail 'production pg_amcheck evidence used unexpected server options'
  completed_epoch="$(tsv_value "$evidence_file" completed_epoch 'production pg_amcheck evidence')"
  require_positive_integer completed_epoch "$completed_epoch"
  recorded_transcript_sha256="$(tsv_value "$evidence_file" transcript_sha256 'production pg_amcheck evidence')"
  [[ "$recorded_transcript_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'production pg_amcheck transcript fingerprint is invalid'
  sha256_file "$transcript_file"
  actual_transcript_sha256="$REPLY"
  [[ "$actual_transcript_sha256" == "$recorded_transcript_sha256" ]] ||
    fail 'production pg_amcheck transcript does not match its evidence marker'
}

run_production_amcheck() {
  local state_directory="$1" client_version client_major expected_options expected_server_options
  local completed_epoch amcheck_exit failed_transcript
  local transcript_pending evidence_pending transcript_sha256
  local -a amcheck_options=(
    --no-password --jobs=1 --parent-check --heapallindexed --progress --verbose
  )
  assert_repair_acknowledgements "$state_directory"
  assert_state_identity "$state_directory"
  assert_user_reindex_complete "$state_directory"
  assert_system_reindex_complete "$state_directory"
  assert_maintenance_fence "$state_directory"
  if [[ -e "$state_directory/production-amcheck.tsv" ||
        -L "$state_directory/production-amcheck.tsv" ]]; then
    assert_production_amcheck_evidence "$state_directory"
    printf 'Production pg_amcheck evidence is already complete.\n'
    return 0
  fi
  require_command pg_amcheck
  client_version="$(pg_amcheck --version)"
  [[ "$client_version" != *$'\t'* && "$client_version" != *$'\n'* ]] ||
    fail 'pg_amcheck --version returned an unsafe value'
  if [[ "$client_version" =~ PostgreSQL\)\ ([0-9]+)([.][0-9]+) ]]; then
    client_major="${BASH_REMATCH[1]}"
  else
    fail 'could not parse pg_amcheck client version'
  fi
  [[ "$client_major" == "$EXPECTED_SOURCE_MAJOR" ]] ||
    fail "pg_amcheck client major is $client_major, expected $EXPECTED_SOURCE_MAJOR"
  expected_options='--no-password --jobs=1 --parent-check --heapallindexed --progress --verbose'
  expected_server_options="-c lock_timeout=5000 -c statement_timeout=43200000 -c maintenance_work_mem=${REINDEX_MAINTENANCE_WORK_MEM} -c application_name=boardsesh-production-amcheck"
  transcript_pending="$CREDENTIALS_DIRECTORY/production-amcheck.log"
  evidence_pending="$CREDENTIALS_DIRECTORY/production-amcheck.tsv"
  {
    printf 'client=%s\n' "$client_version"
    printf 'options=%s\n' "$expected_options"
    printf 'server_options=%s\n' "$expected_server_options"
  } >"$transcript_pending"
  chmod 0600 "$transcript_pending"
  if BOARDSESH_LIBPQ_CONNECT_TIMEOUT=10 \
    BOARDSESH_LIBPQ_EXTRA_OPTIONS="$expected_server_options" \
    boardsesh_run_libpq_connection ADMIN pg_amcheck "${amcheck_options[@]}" \
      >>"$transcript_pending" 2>&1; then
    :
  else
    amcheck_exit="$?"
    failed_transcript="$state_directory/production-amcheck.failed.$(date +%s).$$.log"
    [[ ! -e "$failed_transcript" && ! -L "$failed_transcript" ]] ||
      fail 'refusing to replace an existing failed pg_amcheck transcript'
    mv -- "$transcript_pending" "$failed_transcript"
    chmod 0600 "$failed_transcript"
    fail "production pg_amcheck exited $amcheck_exit; retained its transcript at $failed_transcript"
  fi
  assert_state_identity "$state_directory"
  assert_user_reindex_complete "$state_directory"
  assert_system_reindex_complete "$state_directory"
  assert_maintenance_fence "$state_directory"
  sha256_file "$transcript_pending"
  transcript_sha256="$REPLY"
  completed_epoch="$(date +%s)"
  {
    printf 'format\tboardsesh-postgres16-production-amcheck-v1\n'
    printf 'system_identifier\t%s\n' "$(metadata_value "$state_directory" system_identifier)"
    printf 'server_version_num\t%s\n' "$(metadata_value "$state_directory" server_version_num)"
    printf 'database\t%s\n' "$(metadata_value "$state_directory" database)"
    printf 'actual_collation_version\t%s\n' \
      "$(metadata_value "$state_directory" actual_collation_version)"
    printf 'index_manifest_sha256\t%s\n' \
      "$(metadata_value "$state_directory" index_manifest_sha256)"
    printf 'user_reindex_marker\t%s\n' "$(<"$state_directory/user-reindex.complete")"
    printf 'system_reindex_marker\t%s\n' "$(<"$state_directory/system-reindex.complete")"
    printf 'postgis_full_version_sha256\t%s\n' \
      "$(metadata_value "$state_directory" postgis_full_version_sha256)"
    printf 'connection_containment_evidence_sha256\t%s\n' \
      "$(metadata_value "$state_directory" connection_containment_evidence_sha256)"
    printf 'pg_amcheck_client_version\t%s\n' "$client_version"
    printf 'pg_amcheck_client_major\t%s\n' "$client_major"
    printf 'pg_amcheck_options\t%s\n' "$expected_options"
    printf 'pg_amcheck_server_options\t%s\n' "$expected_server_options"
    printf 'completed_epoch\t%s\n' "$completed_epoch"
    printf 'transcript_sha256\t%s\n' "$transcript_sha256"
  } >"$evidence_pending"
  chmod 0600 "$evidence_pending"
  mv -f -- "$transcript_pending" "$state_directory/production-amcheck.log"
  mv -f -- "$evidence_pending" "$state_directory/production-amcheck.tsv"
  chmod 0600 "$state_directory/production-amcheck.log" \
    "$state_directory/production-amcheck.tsv"
  assert_production_amcheck_evidence "$state_directory"
  printf 'Production pg_amcheck completed and its transcript is bound to this repair state.\n'
}

assert_postgis_contract() {
  local postgis_installed postgis_full_version normalized_postgis_version spatial_contract
  local spatial_index_plans
  postgis_installed="$(readonly_scalar "
SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'postgis');")"
  [[ "$postgis_installed" == 't' ]] ||
    fail 'PostGIS is not installed on the production repair target'
  postgis_full_version="$(readonly_scalar 'SELECT public.postgis_full_version();')"
  normalized_postgis_version="$(printf '%s' "$postgis_full_version" | tr '[:upper:]' '[:lower:]')"
  [[ "$normalized_postgis_version" != *'need upgrade'* ]] ||
    fail 'PostGIS reports extension SQL objects that need upgrade; repair and rehearse them before collation refresh'
  spatial_contract="$(run_readonly -Atq -F $'\t' <<'SQL'
SELECT (SELECT count(*) = 1
        FROM public.geography_columns
        WHERE f_table_schema = 'public'
          AND f_table_name = 'gyms'
          AND f_geography_column = 'location'
          AND type = 'Point'
          AND srid = 4326),
       (SELECT count(*) = 1
        FROM public.geography_columns
        WHERE f_table_schema = 'public'
          AND f_table_name = 'user_boards'
          AND f_geography_column = 'location'
          AND type = 'Point'
          AND srid = 4326),
       (SELECT count(*) = 0
        FROM public.gyms
        WHERE location IS NOT NULL
          AND (public.ST_SRID(location::public.geometry) <> 4326
               OR public.GeometryType(location::public.geometry) <> 'POINT'
               OR NOT public.ST_IsValid(location::public.geometry))),
       (SELECT count(*) = 0
        FROM public.user_boards
        WHERE location IS NOT NULL
          AND (public.ST_SRID(location::public.geometry) <> 4326
               OR public.GeometryType(location::public.geometry) <> 'POINT'
               OR NOT public.ST_IsValid(location::public.geometry))),
       (SELECT count(*) = 1
        FROM pg_catalog.pg_class AS index_relation
        JOIN pg_catalog.pg_namespace AS index_namespace
          ON index_namespace.oid = index_relation.relnamespace
        JOIN pg_catalog.pg_index AS index_row ON index_row.indexrelid = index_relation.oid
        JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
        WHERE index_namespace.nspname = 'public'
          AND index_relation.relname = 'gyms_location_idx'
          AND access_method.amname = 'gist'
          AND index_row.indisvalid AND index_row.indisready AND index_row.indislive),
       (SELECT count(*) = 1
        FROM pg_catalog.pg_class AS index_relation
        JOIN pg_catalog.pg_namespace AS index_namespace
          ON index_namespace.oid = index_relation.relnamespace
        JOIN pg_catalog.pg_index AS index_row ON index_row.indexrelid = index_relation.oid
        JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
        WHERE index_namespace.nspname = 'public'
          AND index_relation.relname = 'user_boards_location_gist_idx'
          AND access_method.amname = 'gist'
          AND index_row.indisvalid AND index_row.indisready AND index_row.indislive);
SQL
)"
  [[ "$spatial_contract" == $'t\tt\tt\tt\tt\tt' ]] ||
    fail 'Boardsesh geography columns, Point/4326 values, or GiST indexes failed validation'
  spatial_index_plans="$(run_readonly -Atq <<'SQL'
SET enable_seqscan = off;
EXPLAIN (FORMAT JSON, COSTS OFF)
SELECT id
FROM public.gyms
WHERE deleted_at IS NULL
  AND is_public = true
  AND public.ST_DWithin(
        location,
        public.ST_SetSRID(public.ST_MakePoint(0, 0), 4326)::public.geography,
        1000);
EXPLAIN (FORMAT JSON, COSTS OFF)
SELECT id
FROM public.user_boards
WHERE is_public = true
  AND deleted_at IS NULL
  AND public.ST_DWithin(
        location,
        public.ST_SetSRID(public.ST_MakePoint(0, 0), 4326)::public.geography,
        1000);
SQL
)"
  [[ "$spatial_index_plans" == *'gyms_location_idx'* &&
     "$spatial_index_plans" == *'user_boards_location_gist_idx'* ]] ||
    fail 'representative geography queries do not plan through both GiST indexes'
}

validate_repair() {
  local state_directory="$1" manifest_sha256 constraint_blockers refresh_ack
  assert_repair_acknowledgements "$state_directory"
  assert_state_identity "$state_directory"
  assert_user_reindex_complete "$state_directory"
  manifest_sha256="$(metadata_value "$state_directory" index_manifest_sha256)"
  assert_system_reindex_complete "$state_directory"
  assert_production_amcheck_evidence "$state_directory"
  constraint_blockers="$(readonly_scalar "
SELECT count(*)
FROM pg_catalog.pg_constraint AS constraint_row
JOIN pg_catalog.pg_namespace AS constraint_namespace
  ON constraint_namespace.oid = constraint_row.connamespace
WHERE constraint_namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
  AND constraint_namespace.nspname <> 'information_schema'
  AND NOT constraint_row.convalidated;")"
  [[ "$constraint_blockers" == '0' ]] ||
    fail "$constraint_blockers user constraints are not validated"
  assert_postgis_contract
  refresh_ack="refresh:$(metadata_value "$state_directory" system_identifier):$(metadata_value "$state_directory" actual_collation_version):$manifest_sha256"
  printf 'Collation repair validation passed.\n'
  printf 'COLLATION_REFRESH_ACK=%s\n' "$refresh_ack"
}

refresh_named_collations() {
  local state_directory="$1" named_manifest_sha256 refresh_sql named_snapshot named_count named_sha256
  local named_dependency_count expected_named_count
  named_manifest_sha256="$(metadata_value "$state_directory" named_collation_manifest_sha256)"
  expected_named_count="$(metadata_value "$state_directory" named_collation_mismatch_count)"
  if state_marker_matches "$state_directory" named-collations-refresh.complete \
    "$named_manifest_sha256"; then
    return 0
  fi
  if ! state_marker_matches "$state_directory" named-collations-refresh.started \
    "$named_manifest_sha256"; then
    write_state_marker "$state_directory" named-collations-refresh.started \
      "$named_manifest_sha256"
  fi
  named_snapshot="$(named_collation_snapshot)"
  IFS=$'\t' read -r named_count named_sha256 named_dependency_count <<<"$named_snapshot"
  [[ "$named_dependency_count" == '0' ]] ||
    fail 'a dependent object began using a mismatched named collation before refresh'
  if [[ "$named_count" == '0' ]]; then
    write_state_marker "$state_directory" named-collations-refresh.complete \
      "$named_manifest_sha256"
    return 0
  fi
  [[ "$named_count" == "$expected_named_count" && "$named_sha256" == "$named_manifest_sha256" ]] ||
    fail 'named-collation mismatch set changed before refresh'
  refresh_sql="$CREDENTIALS_DIRECTORY/refresh-named-collations.sql"
  run_readonly -Atq -o "$refresh_sql" <<'SQL'
SELECT pg_catalog.format('ALTER COLLATION %I.%I REFRESH VERSION;',
                         collation_namespace.nspname, collation_row.collname)
FROM pg_catalog.pg_collation AS collation_row
JOIN pg_catalog.pg_namespace AS collation_namespace
  ON collation_namespace.oid = collation_row.collnamespace
WHERE collation_row.collversion IS NOT NULL
  AND pg_catalog.pg_collation_actual_version(collation_row.oid) IS NOT NULL
  AND collation_row.collversion <> pg_catalog.pg_collation_actual_version(collation_row.oid)
ORDER BY collation_namespace.nspname, collation_row.collname;
SQL
  chmod 0600 "$refresh_sql"
  if [[ -s "$refresh_sql" ]]; then
    printf 'Refreshing %s dependency-free named collation versions in one transaction.\n' \
      "$(metadata_value "$state_directory" named_collation_mismatch_count)"
    run_maintenance \
      '-c lock_timeout=5000 -c statement_timeout=300000 -c application_name=boardsesh-named-collation-refresh' \
      --single-transaction -f "$refresh_sql"
  fi
  named_snapshot="$(named_collation_snapshot)"
  IFS=$'\t' read -r named_count named_sha256 named_dependency_count <<<"$named_snapshot"
  [[ "$named_count" == '0' && "$named_dependency_count" == '0' ]] ||
    fail 'named collation versions still mismatch after refresh'
  write_state_marker "$state_directory" named-collations-refresh.complete \
    "$named_manifest_sha256"
}

refresh_collation_version() {
  local state_directory="$1" database_name manifest_sha256 expected_refresh_ack recorded_after actual_after
  local recorded_before actual_before expected_recorded expected_actual
  validate_repair "$state_directory"
  assert_maintenance_fence "$state_directory"
  database_name="$(metadata_value "$state_directory" database)"
  manifest_sha256="$(metadata_value "$state_directory" index_manifest_sha256)"
  expected_refresh_ack="refresh:$(metadata_value "$state_directory" system_identifier):$(metadata_value "$state_directory" actual_collation_version):$manifest_sha256"
  [[ "${COLLATION_REFRESH_ACK:-}" == "$expected_refresh_ack" ]] ||
    fail "COLLATION_REFRESH_ACK must exactly equal $expected_refresh_ack"
  refresh_named_collations "$state_directory"
  if state_marker_matches "$state_directory" collation-refresh.complete "$manifest_sha256"; then
    printf 'Database collation version refresh is already complete.\n'
    return 0
  fi
  if ! state_marker_matches "$state_directory" collation-refresh.started "$manifest_sha256"; then
    write_state_marker "$state_directory" collation-refresh.started "$manifest_sha256"
  fi
  expected_recorded="$(metadata_value "$state_directory" recorded_collation_version)"
  expected_actual="$(metadata_value "$state_directory" actual_collation_version)"
  IFS=$'\t' read -r recorded_before actual_before <<<"$(run_readonly -Atq -F $'\t' -c "
SELECT coalesce(database.datcollversion, ''),
       coalesce(pg_catalog.pg_database_collation_actual_version(database.oid), '')
FROM pg_catalog.pg_database AS database
WHERE database.datname = current_database();")"
  if [[ "$recorded_before" == "$expected_recorded" && "$actual_before" == "$expected_actual" &&
        "$recorded_before" != "$actual_before" ]]; then
    run_maintenance \
      '-c lock_timeout=5000 -c statement_timeout=30000 -c application_name=boardsesh-collation-refresh' \
      -c "ALTER DATABASE \"$database_name\" REFRESH COLLATION VERSION;"
  elif [[ "$recorded_before" == "$actual_before" && "$actual_before" == "$expected_actual" ]]; then
    printf 'Reconciling a database collation refresh that committed before local evidence.\n'
  else
    fail 'database collation versions changed outside the started refresh operation'
  fi
  IFS=$'\t' read -r recorded_after actual_after <<<"$(run_readonly -Atq -F $'\t' -c "
SELECT coalesce(database.datcollversion, ''),
       coalesce(pg_catalog.pg_database_collation_actual_version(database.oid), '')
FROM pg_catalog.pg_database AS database
WHERE database.datname = current_database();")"
  [[ -n "$recorded_after" && "$recorded_after" == "$actual_after" ]] ||
    fail 'database collation version still does not match after refresh'
  [[ "$actual_after" == "$expected_actual" ]] ||
    fail 'database collation actual version changed during refresh'
  assert_state_identity "$state_directory"
  write_state_marker "$state_directory" collation-refresh.complete "$manifest_sha256"
  printf 'Database collation version now records %s.\n' "$recorded_after"
}

main() {
  local command="${1:-}" state_directory="${2:-}"
  if [[ "$command" == '-h' || "$command" == '--help' || -z "$command" ]]; then
    usage
    [[ -n "$command" ]] || return 1
    return 0
  fi
  [[ -n "$state_directory" ]] || fail 'STATE_DIRECTORY is required'
  [[ "$#" -eq 2 ]] || fail 'expected exactly COMMAND and STATE_DIRECTORY'
  require_command psql
  require_command awk
  require_command date
  require_command grep
  require_command mktemp
  require_command mv
  require_command tr
  validate_configuration
  prepare_connection
  case "$command" in
    audit)
      write_audit_state "$state_directory"
      ;;
    status)
      assert_secure_state_directory "$state_directory"
      acquire_state_lock "$state_directory" status
      assert_state_identity "$state_directory"
      show_status "$state_directory"
      ;;
    reindex-next)
      assert_secure_state_directory "$state_directory"
      acquire_state_lock "$state_directory" reindex-next
      reindex_next "$state_directory"
      ;;
    reindex-system)
      assert_secure_state_directory "$state_directory"
      acquire_state_lock "$state_directory" reindex-system
      reindex_system "$state_directory"
      ;;
    amcheck)
      assert_secure_state_directory "$state_directory"
      acquire_state_lock "$state_directory" amcheck
      run_production_amcheck "$state_directory"
      ;;
    validate)
      assert_secure_state_directory "$state_directory"
      acquire_state_lock "$state_directory" validate
      validate_repair "$state_directory"
      ;;
    refresh)
      assert_secure_state_directory "$state_directory"
      acquire_state_lock "$state_directory" refresh
      refresh_collation_version "$state_directory"
      ;;
    *)
      usage >&2
      fail "unknown command: $command"
      ;;
  esac
}

main "$@"
