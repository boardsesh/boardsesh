#!/usr/bin/env bash
if [[ $- == *x* ]]; then
  # Database URLs are accepted through the environment. Disable inherited shell
  # tracing before expanding them so an operator cannot accidentally print a
  # credential by invoking this helper with `bash -x`.
  set +x
fi
set -Eeuo pipefail
umask 077

PUBLICATION_NAME="${PUBLICATION_NAME:-boardsesh_pg18_migration}"
SUBSCRIPTION_NAME="${SUBSCRIPTION_NAME:-boardsesh_pg18_sub}"
SLOT_NAME="${SLOT_NAME:-boardsesh_pg18_migration}"
CHECK_TABLES="${CHECK_TABLES:-boardsesh_ticks board_user_syncs comments votes feed_items users}"
LOAD_SCHEMA="${LOAD_SCHEMA:-true}"
INCLUDE_SCHEMAS="${INCLUDE_SCHEMAS:-public drizzle}"
EXCLUDE_SCHEMAS="${EXCLUDE_SCHEMAS:-neon_auth neon_control_plane}"
TARGET_SNAPSHOT_FENCE_OWNER_ROLE="${TARGET_SNAPSHOT_FENCE_OWNER_ROLE:-boardsesh_snapshot_fence_owner}"
TARGET_RUNTIME_ROLE="${TARGET_RUNTIME_ROLE:-}"
TARGET_RUNTIME_SCHEMAS="${TARGET_RUNTIME_SCHEMAS:-}"
TARGET_MIGRATOR_ROLE="${TARGET_MIGRATOR_ROLE:-}"
SOURCE_DATABASE_NAME="${SOURCE_DATABASE_NAME:-railway}"
TARGET_DATABASE_NAME="${TARGET_DATABASE_NAME:-railway}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/postgres-credentials.sh
source "$SCRIPT_DIR/lib/postgres-credentials.sh"
NEON_DATABASE_URL="${NEON_DATABASE_URL:-${SOURCE_DATABASE_URL:-}}"
RAILWAY_DATABASE_URL="${RAILWAY_DATABASE_URL:-${TARGET_DATABASE_URL:-}}"
NEON_REPLICATION_DATABASE_URL="${NEON_REPLICATION_DATABASE_URL:-${SOURCE_REPLICATION_DATABASE_URL:-}}"
OPERATION_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-pg18-replication.XXXXXX")"
readonly OPERATION_TEMP_DIR
PUBLISHER_CONNINFO_FILE=""
PUBLISHER_REDACTED_CONNINFO_FILE=""
PUBLISHER_CONNINFO_DIGEST=""
PUBLISHER_REDACTED_CONNINFO_DIGEST=""

cleanup() {
  rm -rf "$OPERATION_TEMP_DIR"
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage:
  scripts/postgres-logical-replication.sh setup
  scripts/postgres-logical-replication.sh status
  scripts/postgres-logical-replication.sh sync-sequences
  scripts/postgres-logical-replication.sh teardown

Environment:
  NEON_DATABASE_URL                 Neon admin/source connection string.
  RAILWAY_DATABASE_URL              Railway direct Postgres connection string.
  NEON_REPLICATION_DATABASE_URL     Required for every command. Publisher conninfo for
                                    the exact subscription contract; must use a role with
                                    REPLICATION. Teardown uses it only after validation.
  SOURCE_DATABASE_URL               Generic alias for NEON_DATABASE_URL.
  TARGET_DATABASE_URL               Generic alias for RAILWAY_DATABASE_URL.
  SOURCE_REPLICATION_DATABASE_URL   Generic alias for NEON_REPLICATION_DATABASE_URL.
  TARGET_OWNER_ROLE                 Required for setup/status/sequence sync. Teardown needs
                                    it only to drop a still-present subscription or the
                                    temporary subscriber role; orphan slot and publication
                                    cleanup runs without it.
                                    Existing NOLOGIN, non-superuser role with database
                                    CREATE that owns restored app schemas and objects.
  TARGET_SUBSCRIBER_ROLE            Required for setup/status/sequence sync. Same teardown
                                    rule as TARGET_OWNER_ROLE.
                                    Dedicated temporary LOGIN subscription owner with no
                                    app credential that can SET ROLE to TARGET_OWNER_ROLE;
                                    do not use the target admin. Teardown drops it.
  TARGET_RUNTIME_ROLE               Required for setup. Existing exact restricted LOGIN
                                    app role. Setup reconstructs its direct object/default
                                    ACLs after the --no-acl schema restore.
  TARGET_RUNTIME_SCHEMAS            Required for setup. Space-separated subset of
                                    INCLUDE_SCHEMAS that runtime may access. Keep privileged
                                    schemas such as post-cutover ops out of this list.
  TARGET_MIGRATOR_ROLE              Required for setup. Exact restricted LOGIN whose only
                                    outgoing edge is SET-only to TARGET_OWNER_ROLE.
  TARGET_SNAPSHOT_FENCE_OWNER_ROLE  Pre-provisioned NOLOGIN snapshot privilege boundary
                                    (default boardsesh_snapshot_fence_owner).
  PUBLICATION_NAME                  Optional, default boardsesh_pg18_migration.
  SUBSCRIPTION_NAME                 Optional, default boardsesh_pg18_sub.
  SLOT_NAME                         Optional, default boardsesh_pg18_migration.
  CHECK_TABLES                      Optional space-separated unqualified table names
                                    (no schema prefix) for status row counts.
  LOAD_SCHEMA                       Optional setup flag, default true. Set false if Railway
                                    schema was already prepared and target tables are empty.
  INCLUDE_SCHEMAS                   Required publication/sequence allowlist. Default:
                                    "public drizzle".
  EXCLUDE_SCHEMAS                   Optional space-separated schema names to exclude from
                                    publication, target-empty check, and sequence sync.
                                    Default: "neon_auth neon_control_plane" (Neon-managed
                                    schemas that have no equivalent on a portable target).
  WRITES_FENCED                    Must be true for sync-sequences. The command refuses
                                    to copy state while source writers can advance it.
  FENCED_WRITER_ROLES              Space-separated app/sync/migrator role names. Every
                                    role must be NOLOGIN with zero active sessions before
                                    sync-sequences will proceed.
  TEARDOWN_CONFIRMED               Must be true for teardown. Set only after the 72-hour
                                    acceptance window and successful PG18 restore drill.

Commands:
  setup
    Verifies Neon logical replication, creates Railway extensions, loads Neon
    schema only, creates/updates the Neon app-table publication, and creates
    the Railway subscription with copy_data=true. Re-run with LOAD_SCHEMA=false
    if the schema was already loaded on a previous attempt.

  status
    Shows replication status and compares row counts for CHECK_TABLES.

  sync-sequences
    Copies owned sequence-relation state from Neon to Railway, including the
    never-called state. Run only after every source writer is fenced.

  teardown
    Drops the Railway subscription, the Neon slot, and the Neon publication after
    the guarded post-cutover acceptance window, then removes TARGET_SUBSCRIBER_ROLE
    once all three are provably gone. The role is dropped only when it still
    matches the exact temporary-subscriber contract setup asserted; anything else
    is left alone and reported. Re-running after a partial teardown is safe.
    With TARGET_OWNER_ROLE/TARGET_SUBSCRIBER_ROLE unset it still drops an orphan
    slot and the publication, then stops and tells you to re-run with both set.
USAGE
}

fail() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found in PATH"
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "$name is required"
}

require_identifier() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "$name must be a simple SQL identifier"
}

validate_schema_policy_lists() {
  local schema seen_included=' ' seen_excluded=' '
  for schema in $INCLUDE_SCHEMAS; do
    require_identifier INCLUDE_SCHEMAS "$schema"
    [[ "$seen_included" != *" $schema "* ]] ||
      fail "INCLUDE_SCHEMAS contains duplicate schema $schema"
    seen_included+="$schema "
  done
  [[ "$seen_included" != ' ' ]] || fail 'INCLUDE_SCHEMAS must list every application schema'
  for schema in $EXCLUDE_SCHEMAS; do
    require_identifier EXCLUDE_SCHEMAS "$schema"
    [[ "$seen_excluded" != *" $schema "* ]] ||
      fail "EXCLUDE_SCHEMAS contains duplicate schema $schema"
    [[ "$seen_included" != *" $schema "* ]] ||
      fail "schema $schema cannot appear in both INCLUDE_SCHEMAS and EXCLUDE_SCHEMAS"
    seen_excluded+="$schema "
  done
}

assert_source_schema_manifest() {
  local schema requested_values='' missing_schema_count
  for schema in $INCLUDE_SCHEMAS; do
    requested_values+="${requested_values:+, }('$schema')"
  done
  missing_schema_count="$(psql_neon -X -Atq -c "
SELECT count(*)
FROM (VALUES ${requested_values}) AS requested(schema_name)
WHERE pg_catalog.to_regnamespace(requested.schema_name) IS NULL;")"
  [[ "$missing_schema_count" == '0' ]] ||
    fail "source is missing $missing_schema_count schema(s) named by INCLUDE_SCHEMAS"
}

prepare_common_connections() {
  boardsesh_prepare_libpq_connection SOURCE "$NEON_DATABASE_URL" "$OPERATION_TEMP_DIR"
  boardsesh_prepare_libpq_connection TARGET "$RAILWAY_DATABASE_URL" "$OPERATION_TEMP_DIR"
  unset NEON_DATABASE_URL SOURCE_DATABASE_URL RAILWAY_DATABASE_URL TARGET_DATABASE_URL
}

prepare_publisher_connection() {
  boardsesh_prepare_libpq_connection PUBLISHER "$NEON_REPLICATION_DATABASE_URL" "$OPERATION_TEMP_DIR"
  if [[ " ${BOARDSESH_LIBPQ_PUBLISHER_ENV_NAMES:-} " == *' PGAPPNAME '* ]]; then
    [[ "${BOARDSESH_LIBPQ_PUBLISHER_PGAPPNAME}" == "$SUBSCRIPTION_NAME" ]] ||
      fail "publisher application_name must equal the canonical subscription name $SUBSCRIPTION_NAME"
  else
    boardsesh_store_libpq_env PUBLISHER PGAPPNAME "$SUBSCRIPTION_NAME"
  fi
  PUBLISHER_CONNINFO_FILE="$OPERATION_TEMP_DIR/publisher.conninfo"
  PUBLISHER_REDACTED_CONNINFO_FILE="$OPERATION_TEMP_DIR/publisher-redacted.conninfo"
  [[ -n "${BOARDSESH_LIBPQ_PUBLISHER_PASSWORD:-}" ]] ||
    fail "NEON_REPLICATION_DATABASE_URL must contain a password for password_required=true"
  boardsesh_write_libpq_conninfo PUBLISHER "$PUBLISHER_CONNINFO_FILE" true
  boardsesh_write_libpq_conninfo PUBLISHER "$PUBLISHER_REDACTED_CONNINFO_FILE" false
  boardsesh_md5_conninfo_file "$PUBLISHER_CONNINFO_FILE"
  PUBLISHER_CONNINFO_DIGEST="$REPLY"
  boardsesh_md5_conninfo_file "$PUBLISHER_REDACTED_CONNINFO_FILE"
  PUBLISHER_REDACTED_CONNINFO_DIGEST="$REPLY"
  unset NEON_REPLICATION_DATABASE_URL SOURCE_REPLICATION_DATABASE_URL
}

schema_exclude_clause() {
  local column="$1"
  local quoted=""
  local schema
  for schema in $EXCLUDE_SCHEMAS; do
    require_identifier EXCLUDE_SCHEMAS "$schema"
    if [[ -n "$quoted" ]]; then
      quoted+=", "
    fi
    quoted+="'$schema'"
  done
  if [[ -n "$quoted" ]]; then
    printf 'AND %s NOT IN (%s)' "$column" "$quoted"
  fi
}

schema_include_clause() {
  local column="$1"
  local quoted=""
  local schema
  for schema in $INCLUDE_SCHEMAS; do
    require_identifier INCLUDE_SCHEMAS "$schema"
    if [[ -n "$quoted" ]]; then
      quoted+=", "
    fi
    quoted+="'$schema'"
  done
  [[ -n "$quoted" ]] || fail "INCLUDE_SCHEMAS must list every application schema"
  printf 'AND %s IN (%s)' "$column" "$quoted"
}

runtime_schema_include_clause() {
  local column="$1"
  local quoted=""
  local schema
  require_env TARGET_RUNTIME_SCHEMAS
  for schema in $TARGET_RUNTIME_SCHEMAS; do
    require_identifier TARGET_RUNTIME_SCHEMAS "$schema"
    [[ " $INCLUDE_SCHEMAS " == *" $schema "* ]] ||
      fail "TARGET_RUNTIME_SCHEMAS entry $schema is not classified by INCLUDE_SCHEMAS"
    [[ " $EXCLUDE_SCHEMAS " != *" $schema "* ]] ||
      fail "TARGET_RUNTIME_SCHEMAS entry $schema is excluded by EXCLUDE_SCHEMAS"
    if [[ -n "$quoted" ]]; then
      quoted+=", "
    fi
    quoted+="'$schema'"
  done
  [[ -n "$quoted" ]] || fail "TARGET_RUNTIME_SCHEMAS must list every runtime-accessible schema"
  printf 'AND %s IN (%s)' "$column" "$quoted"
}

included_schemas_csv() {
  local joined=""
  local schema
  for schema in $INCLUDE_SCHEMAS; do
    require_identifier INCLUDE_SCHEMAS "$schema"
    if [[ -n "$joined" ]]; then
      joined+=","
    fi
    joined+="$schema"
  done
  [[ -n "$joined" ]] || fail "INCLUDE_SCHEMAS must list every application schema"
  printf '%s' "$joined"
}

excluded_schemas_csv() {
  local joined=""
  local schema
  for schema in $EXCLUDE_SCHEMAS; do
    require_identifier EXCLUDE_SCHEMAS "$schema"
    if [[ -n "$joined" ]]; then
      joined+=","
    fi
    joined+="$schema"
  done
  printf '%s' "$joined"
}

quoted_role_list() {
  local joined=""
  local role
  for role in $FENCED_WRITER_ROLES; do
    require_identifier FENCED_WRITER_ROLES "$role"
    if [[ -n "$joined" ]]; then
      joined+=", "
    fi
    joined+="'$role'"
  done
  [[ -n "$joined" ]] || fail "FENCED_WRITER_ROLES must list every app, sync, and migrator writer role"
  printf '%s' "$joined"
}

psql_neon() {
  boardsesh_run_libpq_connection SOURCE psql -X -v ON_ERROR_STOP=1 "$@"
}

psql_railway() {
  boardsesh_run_libpq_connection TARGET psql -X -v ON_ERROR_STOP=1 "$@"
}

psql_publisher() {
  boardsesh_run_libpq_connection PUBLISHER psql -X -v ON_ERROR_STOP=1 "$@"
}

publication_table_manifest() {
  local include_clause exclude_clause
  include_clause="$(schema_include_clause 'n.nspname')"
  exclude_clause="$(schema_exclude_clause 'n.nspname')"
  psql_neon -X -Atq <<SQL
SELECT format('%I.%I', n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
-- With publish_via_partition_root=false, PostgreSQL registers and synchronizes
-- leaf relations. A partitioned root belongs in CREATE PUBLICATION so future
-- partitions are included, but it does not get a pg_subscription_rel row.
WHERE c.relkind = 'r'
  AND c.relpersistence = 'p'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname !~ '^pg_toast'
  ${include_clause}
  ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1
    FROM pg_depend d
    WHERE d.classid = 'pg_class'::regclass
      AND d.objid = c.oid
      AND d.deptype = 'e'
  )
ORDER BY 1;
SQL
}

validate_publisher_credential() {
  [[ -n "${BOARDSESH_LIBPQ_PUBLISHER_ENV_NAMES:-}" ]] ||
    fail "publisher connection was not prepared"

  local include_clause exclude_clause namespace_include_clause namespace_exclude_clause
  include_clause="$(schema_include_clause 'n.nspname')"
  exclude_clause="$(schema_exclude_clause 'n.nspname')"
  namespace_include_clause="$(schema_include_clause 'namespace.nspname')"
  namespace_exclude_clause="$(schema_exclude_clause 'namespace.nspname')"

  local source_database publisher_database publisher_contract publisher_identity publisher_row_security
  source_database="$(psql_neon -X -Atq -c 'SELECT current_database();')"
  publisher_database="$(psql_publisher -Atq -c 'SELECT current_database();')"
  [[ "$publisher_database" == "$source_database" ]] ||
    fail "publisher credential connects to database $publisher_database; expected $source_database"
  publisher_identity="$(psql_publisher -Atq -F '|' -c 'SELECT session_user, current_user;')"
  [[ "$publisher_identity" == "${BOARDSESH_LIBPQ_PUBLISHER_PGUSER}|${BOARDSESH_LIBPQ_PUBLISHER_PGUSER}" ]] ||
    fail 'publisher URL must authenticate directly as its restricted role; startup SET ROLE is forbidden'

  publisher_contract="$(psql_publisher -Atq -c "
SELECT rolcanlogin::text || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' ||
       rolcreaterole::text || '|' || rolinherit::text || '|' || rolreplication::text || '|' ||
       rolbypassrls::text || '|' ||
       (SELECT count(*) = 0 FROM pg_auth_members AS membership
        WHERE membership.member = publisher.oid OR membership.roleid = publisher.oid)::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_shdepend AS dependency
         WHERE dependency.refclassid = 'pg_authid'::regclass
           AND dependency.refobjid = publisher.oid
           AND dependency.deptype = 'o'
       ))::text || '|' ||
       (NOT has_database_privilege(publisher.oid, current_database(), 'CREATE'))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_namespace AS namespace
         WHERE namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND has_schema_privilege(publisher.oid, namespace.oid, 'CREATE')
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1
         FROM pg_class AS relation
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S')
           AND namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND (
             has_table_privilege(publisher.oid, relation.oid, 'INSERT')
             OR has_table_privilege(publisher.oid, relation.oid, 'UPDATE')
             OR has_table_privilege(publisher.oid, relation.oid, 'DELETE')
             OR has_table_privilege(publisher.oid, relation.oid, 'TRUNCATE')
             OR has_table_privilege(publisher.oid, relation.oid, 'REFERENCES')
             OR has_table_privilege(publisher.oid, relation.oid, 'TRIGGER')
           )
       ))::text
FROM pg_roles AS publisher
WHERE rolname = current_user;")"
  [[ "$publisher_contract" == 'true|false|false|false|true|true|false|true|true|true|true|true' ]] ||
    fail "publisher credential must be an ownership-free exact replication LOGIN with no role edges or effective database/schema CREATE or relation DML"

  publisher_row_security="$(psql_publisher -Atq -c 'SHOW row_security;')"
  [[ "$publisher_row_security" == 'off' ]] ||
    fail "publisher credential must connect with row_security=off so future RLS fails closed"

  local missing_select_privileges
  missing_select_privileges="$(psql_publisher -Atq -c "
SELECT count(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND c.relpersistence = 'p'
  ${include_clause}
  ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1
    FROM aclexplode(c.relacl) AS privilege
    WHERE privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    GROUP BY privilege.grantee
    HAVING count(*) = 1
       AND bool_and(privilege.privilege_type = 'SELECT' AND NOT privilege.is_grantable)
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    WHERE d.classid = 'pg_class'::regclass
      AND d.objid = c.oid
      AND d.deptype = 'e'
  );")"
  [[ "$missing_select_privileges" == '0' ]] ||
    fail "publisher credential lacks direct non-grantable SELECT on $missing_select_privileges published table(s)"

  local missing_schema_usage
  missing_schema_usage="$(psql_publisher -Atq -c "
SELECT count(*)
FROM pg_namespace AS namespace
WHERE true
  ${namespace_include_clause}
  ${namespace_exclude_clause}
  AND EXISTS (
    SELECT 1 FROM pg_class AS relation
    WHERE relation.relnamespace = namespace.oid
      AND relation.relkind IN ('r', 'p')
      AND relation.relpersistence = 'p'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend AS extension_dependency
        WHERE extension_dependency.classid = 'pg_class'::regclass
          AND extension_dependency.objid = relation.oid
          AND extension_dependency.deptype = 'e'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM aclexplode(namespace.nspacl) AS privilege
    WHERE privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    GROUP BY privilege.grantee
    HAVING count(*) = 1
       AND bool_and(privilege.privilege_type = 'USAGE' AND NOT privilege.is_grantable)
  );")"
  [[ "$missing_schema_usage" == '0' ]] ||
    fail "publisher credential lacks direct non-grantable USAGE on $missing_schema_usage application schema(s)"

  local unexpected_relation_acls
  unexpected_relation_acls="$(psql_publisher -Atq -c "
SELECT count(*)
FROM pg_class AS relation
JOIN pg_namespace AS n ON n.oid = relation.relnamespace
CROSS JOIN LATERAL aclexplode(relation.relacl) AS privilege
WHERE privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND NOT (
    relation.relkind IN ('r', 'p')
    AND relation.relpersistence = 'p'
    ${include_clause}
    ${exclude_clause}
    AND privilege.privilege_type = 'SELECT'
    AND NOT privilege.is_grantable
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_class'::regclass
        AND extension_dependency.objid = relation.oid
        AND extension_dependency.deptype = 'e'
    )
  );")"
  [[ "$unexpected_relation_acls" == '0' ]] ||
    fail "publisher credential has $unexpected_relation_acls direct relation ACL(s) outside exact non-grantable SELECT on the publication manifest"

  local unexpected_schema_acls
  unexpected_schema_acls="$(psql_publisher -Atq -c "
SELECT count(*)
FROM pg_namespace AS namespace
CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
WHERE privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND NOT (
    true
    ${namespace_include_clause}
    ${namespace_exclude_clause}
    AND privilege.privilege_type = 'USAGE'
    AND NOT privilege.is_grantable
    AND EXISTS (
      SELECT 1 FROM pg_class AS relation
      WHERE relation.relnamespace = namespace.oid
        AND relation.relkind IN ('r', 'p')
        AND relation.relpersistence = 'p'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend AS extension_dependency
          WHERE extension_dependency.classid = 'pg_class'::regclass
            AND extension_dependency.objid = relation.oid
            AND extension_dependency.deptype = 'e'
        )
    )
  );")"
  [[ "$unexpected_schema_acls" == '0' ]] ||
    fail "publisher credential has $unexpected_schema_acls direct schema ACL(s) outside exact non-grantable USAGE on publication schemas"

  local unexpected_column_acls
  unexpected_column_acls="$(psql_publisher -Atq -c "
SELECT count(*)
FROM pg_attribute AS attribute
CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
WHERE attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user);")"
  [[ "$unexpected_column_acls" == '0' ]] ||
    fail "publisher credential has $unexpected_column_acls direct column ACL(s); publication access must use exact table SELECT grants"

  local unexpected_database_acls unexpected_routine_acls unexpected_type_acls effective_routine_execute
  unexpected_database_acls="$(psql_publisher -Atq -c "
SELECT count(*)
FROM pg_database AS database
CROSS JOIN LATERAL aclexplode(database.datacl) AS privilege
WHERE privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user);")"
  [[ "$unexpected_database_acls" == '0' ]] ||
    fail "publisher credential has $unexpected_database_acls direct database ACL(s); connection must rely only on the reviewed cluster baseline"

  unexpected_routine_acls="$(psql_publisher -Atq -c "
SELECT count(*)
FROM pg_proc AS procedure
CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
WHERE privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user);")"
  [[ "$unexpected_routine_acls" == '0' ]] ||
    fail "publisher credential has $unexpected_routine_acls direct routine ACL(s); publication access is table-only"

  unexpected_type_acls="$(psql_publisher -Atq -c "
SELECT count(*)
FROM pg_type AS type_row
CROSS JOIN LATERAL aclexplode(type_row.typacl) AS privilege
WHERE privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user);")"
  [[ "$unexpected_type_acls" == '0' ]] ||
    fail "publisher credential has $unexpected_type_acls direct type ACL(s); publication access is table-only"

  effective_routine_execute="$(psql_publisher -Atq -c "
SELECT count(*)
FROM pg_proc AS procedure
JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE true ${namespace_include_clause} ${namespace_exclude_clause}
  AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_proc'::regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  );")"
  [[ "$effective_routine_execute" == '0' ]] ||
    fail "publisher credential can effectively EXECUTE $effective_routine_execute non-extension application routine(s); publication access is table-only"

  # Execute a zero-row SELECT against every table. With row_security=off this
  # deliberately errors if a future RLS policy cannot be bypassed.
  psql_publisher -Atq <<SQL
SELECT format('SELECT 1 FROM %I.%I LIMIT 0;', n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND c.relpersistence = 'p'
  ${include_clause}
  ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    WHERE d.classid = 'pg_class'::regclass
      AND d.objid = c.oid
      AND d.deptype = 'e'
  )
ORDER BY n.nspname, c.relname
\gexec
SQL
}

assert_no_source_column_acls() {
  local include_clause exclude_clause column_acl_count
  include_clause="$(schema_include_clause 'namespace.nspname')"
  exclude_clause="$(schema_exclude_clause 'namespace.nspname')"
  column_acl_count="$(psql_neon -Atq -c "
SELECT count(*)
FROM pg_catalog.pg_attribute AS attribute
JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND attribute.attacl IS NOT NULL
  AND relation.relkind IN ('r', 'p', 'v', 'm')
  ${include_clause}
  ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  );")"
  [[ "$column_acl_count" == '0' ]] ||
    fail "source has $column_acl_count included non-extension column ACL(s); --no-acl cannot preserve them, so replace them with exact table ACLs or use a reviewed ACL-preserving migration"
}

assert_source_precedes_snapshot_fence_migration() {
  local source_ops_schema_count
  source_ops_schema_count="$(psql_neon -X -Atq -c "
SELECT count(*)
FROM pg_namespace
WHERE nspname = 'ops';")"
  [[ "$source_ops_schema_count" == '0' ]] ||
    fail "source contains the post-cutover ops schema; complete logical PG18 cutover before applying snapshot-fence migration 0200"
}

validate_target_migrator_role() {
  require_env TARGET_OWNER_ROLE
  require_env TARGET_MIGRATOR_ROLE
  require_identifier TARGET_OWNER_ROLE "$TARGET_OWNER_ROLE"
  require_identifier TARGET_MIGRATOR_ROLE "$TARGET_MIGRATOR_ROLE"

  local migrator_contract
  migrator_contract="$(psql_railway -X -Atq -c "
WITH migrator AS (
  SELECT * FROM pg_roles WHERE rolname = '${TARGET_MIGRATOR_ROLE}'
), owner_role AS (
  SELECT oid FROM pg_roles WHERE rolname = '${TARGET_OWNER_ROLE}'
)
SELECT migrator.rolcanlogin::text || '|' || migrator.rolsuper::text || '|' ||
       migrator.rolcreatedb::text || '|' || migrator.rolcreaterole::text || '|' ||
       migrator.rolinherit::text || '|' || migrator.rolreplication::text || '|' ||
       migrator.rolbypassrls::text || '|' ||
       (
         SELECT count(*) = 1 AND bool_and(
           membership.roleid = owner_role.oid
           AND NOT membership.admin_option
           AND NOT membership.inherit_option
           AND membership.set_option
         )
         FROM pg_auth_members AS membership, owner_role
         WHERE membership.member = migrator.oid
       )::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_auth_members AS membership
         WHERE membership.roleid = migrator.oid
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_shdepend AS dependency
         WHERE dependency.refclassid = 'pg_authid'::regclass
           AND dependency.refobjid = migrator.oid
           AND dependency.deptype = 'o'
       ))::text || '|' ||
       (NOT has_database_privilege(migrator.oid, current_database(), 'CREATE'))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_namespace AS namespace
         WHERE namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND has_schema_privilege(migrator.oid, namespace.oid, 'CREATE')
       ))::text
FROM migrator, owner_role;")"
  [[ "$migrator_contract" == 'true|false|false|false|true|false|false|true|true|true|true|true' ]] ||
    fail "TARGET_MIGRATOR_ROLE must be an ownership-free exact LOGIN whose only edge is no-admin INHERIT-false SET-only to TARGET_OWNER_ROLE"
}

validate_target_subscriber_role() {
  local expected_subscription_state="${1:-optional}"
  [[ "$expected_subscription_state" =~ ^(absent|optional|required)$ ]] ||
    fail "internal subscriber state must be absent, optional, or required"
  require_env TARGET_OWNER_ROLE
  require_env TARGET_SUBSCRIBER_ROLE
  require_identifier TARGET_OWNER_ROLE "$TARGET_OWNER_ROLE"
  require_identifier TARGET_SUBSCRIBER_ROLE "$TARGET_SUBSCRIBER_ROLE"

  local subscriber_contract subscriber_prefix subscription_count
  subscriber_contract="$(psql_railway -X -Atq -c "
WITH subscriber AS (
  SELECT * FROM pg_roles WHERE rolname = '${TARGET_SUBSCRIBER_ROLE}'
), owner_role AS (
  SELECT oid FROM pg_roles WHERE rolname = '${TARGET_OWNER_ROLE}'
), create_subscription_role AS (
  SELECT oid FROM pg_roles WHERE rolname = 'pg_create_subscription'
)
SELECT subscriber.rolcanlogin::text || '|' ||
       subscriber.rolsuper::text || '|' ||
       subscriber.rolcreatedb::text || '|' ||
       subscriber.rolcreaterole::text || '|' ||
       subscriber.rolinherit::text || '|' ||
       subscriber.rolreplication::text || '|' ||
       subscriber.rolbypassrls::text || '|' ||
       (
         SELECT auth.rolpassword IS NULL
         FROM pg_authid AS auth
         WHERE auth.oid = subscriber.oid
       )::text || '|' ||
       (
         SELECT count(*) = 1
           AND bool_and(
             privilege.privilege_type = 'CREATE'
             AND NOT privilege.is_grantable
           )
         FROM pg_database AS database
         CROSS JOIN LATERAL aclexplode(database.datacl) AS privilege
         WHERE database.datname = current_database()
           AND privilege.grantee = subscriber.oid
       )::text || '|' ||
       (
         SELECT count(*) = 1 FROM pg_auth_members AS membership
         WHERE membership.member = subscriber.oid
           AND membership.roleid = create_subscription_role.oid
           AND NOT membership.admin_option
           AND membership.inherit_option
           AND NOT membership.set_option
       )::text || '|' ||
       (
         SELECT count(*) FILTER (
                  WHERE membership.roleid = owner_role.oid
                    AND NOT membership.admin_option
                    AND NOT membership.inherit_option
                    AND membership.set_option
                ) = 1
                AND count(*) = 2
         FROM pg_auth_members AS membership
         WHERE membership.member = subscriber.oid
       )::text || '|' ||
       (
         SELECT count(*) = 0 FROM pg_auth_members AS membership
         WHERE membership.roleid = subscriber.oid
       )::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_namespace AS namespace
         WHERE namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND has_schema_privilege(subscriber.oid, namespace.oid, 'CREATE')
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1
         FROM pg_class AS relation
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S')
           AND namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND (
             has_table_privilege(subscriber.oid, relation.oid, 'INSERT')
             OR has_table_privilege(subscriber.oid, relation.oid, 'UPDATE')
             OR has_table_privilege(subscriber.oid, relation.oid, 'DELETE')
             OR has_table_privilege(subscriber.oid, relation.oid, 'TRUNCATE')
             OR has_table_privilege(subscriber.oid, relation.oid, 'REFERENCES')
             OR has_table_privilege(subscriber.oid, relation.oid, 'TRIGGER')
           )
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1
         FROM pg_shdepend AS dependency
         WHERE dependency.refclassid = 'pg_authid'::regclass
           AND dependency.refobjid = subscriber.oid
           AND dependency.deptype = 'o'
           AND NOT (
             dependency.classid = 'pg_subscription'::regclass
             AND EXISTS (
               SELECT 1 FROM pg_subscription AS subscription
               WHERE subscription.oid = dependency.objid
                 AND subscription.subname = '${SUBSCRIPTION_NAME}'
                 AND subscription.subowner = subscriber.oid
             )
           )
       ))::text || '|' ||
       (current_user = '${TARGET_SUBSCRIBER_ROLE}' OR
        (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) OR
        pg_has_role(current_user, subscriber.oid, 'SET'))::text || '|' ||
       (
         SELECT count(*) FROM pg_subscription AS subscription
         WHERE subscription.subname = '${SUBSCRIPTION_NAME}'
           AND subscription.subowner = subscriber.oid
           AND subscription.subenabled
       )::text
FROM subscriber, owner_role, create_subscription_role;")"
  subscriber_prefix="${subscriber_contract%|*}"
  subscription_count="${subscriber_contract##*|}"
  [[ "$subscriber_prefix" == 'true|false|false|false|true|false|false|true|true|true|true|true|true|true|true|true' ]] ||
    fail "TARGET_SUBSCRIBER_ROLE must be a passwordless ownership-free exact LOGIN with the two expected outgoing edges, no incoming edge, no schema CREATE/DML, and target-admin SET ROLE reachability"
  case "$expected_subscription_state" in
    absent) [[ "$subscription_count" == '0' ]] || fail "subscription must be absent for the subscriber-role contract" ;;
    optional) [[ "$subscription_count" == '0' || "$subscription_count" == '1' ]] || fail "subscriber owns an ambiguous subscription set" ;;
    required) [[ "$subscription_count" == '1' ]] || fail "subscriber must own the enabled expected subscription" ;;
  esac
}

validate_snapshot_fence_owner_role() {
  require_identifier TARGET_SNAPSHOT_FENCE_OWNER_ROLE "$TARGET_SNAPSHOT_FENCE_OWNER_ROLE"

  local fence_owner_contract
  fence_owner_contract="$(psql_railway -X -Atq -c "
WITH fence_owner AS (
  SELECT * FROM pg_roles WHERE rolname = '${TARGET_SNAPSHOT_FENCE_OWNER_ROLE}'
), owner_role AS (
  SELECT oid FROM pg_roles WHERE rolname = '${TARGET_OWNER_ROLE}'
), stats_role AS (
  SELECT oid FROM pg_roles WHERE rolname = 'pg_read_all_stats'
), control_function_contract AS (
  SELECT count(*) = 2 AND bool_and(
           per_function.direct_execute_count = 1
           AND per_function.non_grantable_execute_count = 1
           AND per_function.public_execute_count = 0
         ) AS matches
  FROM (
    SELECT expected.function_oid,
           count(*) FILTER (
             WHERE privilege.grantee = fence_owner.oid
               AND privilege.privilege_type = 'EXECUTE'
           ) AS direct_execute_count,
           count(*) FILTER (
             WHERE privilege.grantee = fence_owner.oid
               AND privilege.privilege_type = 'EXECUTE'
               AND NOT privilege.is_grantable
           ) AS non_grantable_execute_count,
           count(*) FILTER (
             WHERE privilege.grantee = 0
               AND privilege.privilege_type = 'EXECUTE'
           ) AS public_execute_count
    FROM fence_owner
    CROSS JOIN (
    VALUES
      ('pg_catalog.pg_control_system()'::regprocedure),
      ('pg_catalog.pg_control_checkpoint()'::regprocedure)
    ) AS expected(function_oid)
    JOIN pg_proc AS procedure ON procedure.oid = expected.function_oid
    LEFT JOIN LATERAL aclexplode(
      coalesce(procedure.proacl, acldefault('f', procedure.proowner))
    ) AS privilege ON true
    GROUP BY expected.function_oid
  ) AS per_function
), function_acl_boundary AS (
  WITH allowed(function_oid) AS (
    VALUES
      ('pg_catalog.pg_control_system()'::regprocedure),
      ('pg_catalog.pg_control_checkpoint()'::regprocedure),
      (to_regprocedure('ops.board_snapshot_cluster_identity()')),
      (to_regprocedure('ops.acquire_board_snapshot_fence(integer)'))
  ), per_function AS (
    SELECT allowed.function_oid,
           count(*) FILTER (
             WHERE privilege.grantee = fence_owner.oid
               AND privilege.privilege_type = 'EXECUTE'
           ) AS direct_execute_count,
           count(*) FILTER (
             WHERE privilege.grantee = fence_owner.oid
               AND privilege.privilege_type = 'EXECUTE'
               AND NOT privilege.is_grantable
           ) AS non_grantable_execute_count,
           count(*) FILTER (
             WHERE privilege.grantee = 0
               AND privilege.privilege_type = 'EXECUTE'
           ) AS public_execute_count
    FROM allowed
    JOIN pg_proc AS procedure ON procedure.oid = allowed.function_oid
    CROSS JOIN fence_owner
    LEFT JOIN LATERAL aclexplode(
      coalesce(procedure.proacl, acldefault('f', procedure.proowner))
    ) AS privilege ON true
    GROUP BY allowed.function_oid
  )
  SELECT (
           SELECT count(*) = (SELECT count(*) FROM allowed WHERE function_oid IS NOT NULL)
             AND bool_and(direct_execute_count = 1 AND non_grantable_execute_count = 1
                          AND public_execute_count = 0)
           FROM per_function
         )
         AND NOT EXISTS (
           SELECT 1
           FROM fence_owner
           CROSS JOIN pg_proc AS procedure
           CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
           WHERE privilege.grantee = fence_owner.oid
             AND privilege.privilege_type = 'EXECUTE'
             AND NOT EXISTS (
               SELECT 1 FROM allowed WHERE allowed.function_oid = procedure.oid
             )
         ) AS matches
)
SELECT fence_owner.rolcanlogin::text || '|' ||
       fence_owner.rolsuper::text || '|' ||
       fence_owner.rolcreatedb::text || '|' ||
       fence_owner.rolcreaterole::text || '|' ||
       fence_owner.rolinherit::text || '|' ||
       fence_owner.rolreplication::text || '|' ||
       fence_owner.rolbypassrls::text || '|' ||
       (
         SELECT count(*) = 1 FROM pg_auth_members AS membership, stats_role
         WHERE membership.member = fence_owner.oid
           AND membership.roleid = stats_role.oid
           AND NOT membership.admin_option
           AND membership.inherit_option
           AND NOT membership.set_option
       )::text || '|' ||
       (
         SELECT count(*) FILTER (
                  WHERE membership.roleid = fence_owner.oid
                    AND NOT membership.admin_option
                    AND NOT membership.inherit_option
                    AND membership.set_option
                ) = 1
                AND count(*) = 1
         FROM pg_auth_members AS membership, owner_role
         WHERE membership.member = owner_role.oid
       )::text || '|' ||
       control_function_contract.matches::text || '|' ||
       function_acl_boundary.matches::text || '|' ||
       (
         SELECT count(*) = 2
         FROM pg_auth_members AS membership
         WHERE membership.member = fence_owner.oid
            OR membership.roleid = fence_owner.oid
       )::text || '|' ||
       (NOT has_database_privilege(fence_owner.oid, current_database(), 'CREATE'))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_namespace AS namespace
         WHERE namespace.nspname <> 'ops'
           AND namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND has_schema_privilege(fence_owner.oid, namespace.oid, 'CREATE')
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_database AS database
         CROSS JOIN LATERAL aclexplode(database.datacl) AS privilege
         WHERE privilege.grantee = fence_owner.oid
       ))::text || '|' ||
       ((NOT EXISTS (
         SELECT 1 FROM pg_namespace AS namespace
         CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
         WHERE privilege.grantee = fence_owner.oid
           AND NOT (
             namespace.nspname = 'ops'
             AND privilege.privilege_type IN ('USAGE', 'CREATE')
             AND NOT privilege.is_grantable
           )
       )) AND (
         SELECT count(*) = CASE WHEN to_regnamespace('ops') IS NULL THEN 0 ELSE 2 END
                AND coalesce(bool_and(
                  privilege.privilege_type IN ('USAGE', 'CREATE') AND NOT privilege.is_grantable
                ), true)
         FROM pg_namespace AS namespace
         CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
         WHERE namespace.nspname = 'ops' AND privilege.grantee = fence_owner.oid
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_shdepend AS dependency
         WHERE dependency.refclassid = 'pg_authid'::regclass
           AND dependency.refobjid = fence_owner.oid
           AND dependency.deptype = 'o'
           AND NOT (
             dependency.classid = 'pg_proc'::regclass
             AND dependency.objid IN (
               coalesce(to_regprocedure('ops.board_snapshot_cluster_identity()'), 0::oid),
               coalesce(to_regprocedure('ops.acquire_board_snapshot_fence(integer)'), 0::oid)
             )
           )
       ))::text || '|' ||
       ((NOT EXISTS (
         SELECT 1 FROM pg_class AS relation
         CROSS JOIN LATERAL aclexplode(relation.relacl) AS privilege
         WHERE privilege.grantee = fence_owner.oid
       )) AND (NOT EXISTS (
         SELECT 1 FROM pg_type AS type_row
         CROSS JOIN LATERAL aclexplode(type_row.typacl) AS privilege
         WHERE privilege.grantee = fence_owner.oid
       )) AND (NOT EXISTS (
         SELECT 1 FROM pg_attribute AS attribute
         CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
         WHERE attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND privilege.grantee = fence_owner.oid
       )))::text
FROM fence_owner, control_function_contract, function_acl_boundary;")"
  [[ "$fence_owner_contract" == 'false|false|false|false|true|false|false|true|true|true|true|true|true|true|true|true|true|true' ]] ||
    fail "TARGET_SNAPSHOT_FENCE_OWNER_ROLE must match the exact fence role graph, ownership allowlist, schema/column boundary, and direct non-grantable function ACLs"
}

grant_target_subscriber_schema_usage() {
  local include_clause exclude_clause
  include_clause="$(schema_include_clause 'namespace.nspname')"
  exclude_clause="$(schema_exclude_clause 'namespace.nspname')"
  psql_railway <<SQL
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I;',
              namespace.nspname, '$TARGET_SUBSCRIBER_ROLE')
FROM pg_namespace AS namespace
WHERE namespace.nspname <> 'information_schema'
  AND namespace.nspname !~ '^pg_'
ORDER BY namespace.nspname
\gexec
SELECT format('GRANT USAGE ON SCHEMA %I TO %I;',
              namespace.nspname, '$TARGET_SUBSCRIBER_ROLE')
FROM pg_namespace AS namespace
WHERE true
  ${include_clause} ${exclude_clause}
  AND EXISTS (
    SELECT 1 FROM pg_class AS relation
    WHERE relation.relnamespace = namespace.oid
      AND relation.relkind IN ('r', 'p')
      AND relation.relpersistence = 'p'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend AS extension_dependency
        WHERE extension_dependency.classid = 'pg_class'::regclass
          AND extension_dependency.objid = relation.oid
          AND extension_dependency.deptype = 'e'
      )
  )
ORDER BY namespace.nspname
\gexec
SQL
}

apply_target_routine_ownership_policy() {
  local include_clause exclude_clause
  include_clause="$(schema_include_clause 'namespace.nspname')"
  exclude_clause="$(schema_exclude_clause 'namespace.nspname')"

  # pg_restore --role owns explicit dumped routines correctly, but routines
  # synthesized while restoring a range/multirange type can retain the restore
  # login as owner. Reconcile every non-extension routine through the same
  # prokind-aware path so the target cannot pass with split object ownership.
  psql_railway <<SQL
SELECT format(
         CASE WHEN procedure.prokind = 'p'
           THEN 'ALTER PROCEDURE %s OWNER TO %I;'
           ELSE 'ALTER FUNCTION %s OWNER TO %I;'
         END,
         procedure.oid::regprocedure, '${TARGET_OWNER_ROLE}')
FROM pg_proc AS procedure
JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE true ${include_clause} ${exclude_clause}
  AND pg_get_userbyid(procedure.proowner) <> '${TARGET_OWNER_ROLE}'
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_proc'::regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, procedure.proname, procedure.oid
\gexec
SQL
}

apply_target_runtime_acl_policy() {
  require_env TARGET_RUNTIME_ROLE
  require_identifier TARGET_RUNTIME_ROLE "$TARGET_RUNTIME_ROLE"

  local runtime_role_contract include_clause runtime_include_clause exclude_clause
  runtime_role_contract="$(psql_railway -X -Atq -c "
SELECT rolcanlogin::text || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' ||
       rolcreaterole::text || '|' || rolinherit::text || '|' || rolreplication::text || '|' ||
       rolbypassrls::text || '|' ||
       (SELECT count(*) = 0 FROM pg_auth_members AS membership
        WHERE membership.member = role.oid OR membership.roleid = role.oid)::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_shdepend AS dependency
         WHERE dependency.refclassid = 'pg_authid'::regclass
           AND dependency.refobjid = role.oid
           AND dependency.deptype = 'o'
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_database AS database WHERE database.datdba = role.oid
       ))::text || '|' ||
       (NOT has_database_privilege(role.oid, current_database(), 'CREATE'))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_namespace AS namespace
         WHERE namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND has_schema_privilege(role.oid, namespace.oid, 'CREATE')
       ))::text
FROM pg_roles AS role
WHERE role.rolname = '${TARGET_RUNTIME_ROLE}';")"
  [[ "$runtime_role_contract" == 'true|false|false|false|true|false|false|true|true|true|true|true' ]] ||
    fail "TARGET_RUNTIME_ROLE must be an ownership-free exact restricted LOGIN with no incoming/outgoing memberships or effective database/schema CREATE"

  include_clause="$(schema_include_clause 'namespace.nspname')"
  runtime_include_clause="$(runtime_schema_include_clause 'namespace.nspname')"
  exclude_clause="$(schema_exclude_clause 'namespace.nspname')"
  psql_railway <<SQL
SELECT format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC; REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I;',
              namespace.nspname, namespace.nspname, '${TARGET_RUNTIME_ROLE}')
FROM pg_namespace AS namespace
WHERE true ${include_clause} ${exclude_clause}
ORDER BY namespace.nspname
\gexec
SELECT format('GRANT USAGE ON SCHEMA %I TO %I;', namespace.nspname, '${TARGET_RUNTIME_ROLE}')
FROM pg_namespace AS namespace
WHERE true ${runtime_include_clause} ${exclude_clause}
ORDER BY namespace.nspname
\gexec

SELECT format('REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM PUBLIC, %I;',
              attribute.attname, namespace.nspname, relation.relname, '${TARGET_RUNTIME_ROLE}')
FROM pg_attribute AS attribute
JOIN pg_class AS relation ON relation.oid = attribute.attrelid
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
WHERE relation.relkind IN ('r', 'p', 'v', 'm')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND privilege.grantee IN (
    0,
    (SELECT oid FROM pg_roles WHERE rolname = '${TARGET_RUNTIME_ROLE}')
  )
  ${include_clause} ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_class'::regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname, attribute.attnum
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, %I;', namespace.nspname,
              relation.relname, '${TARGET_RUNTIME_ROLE}')
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p', 'v', 'm')
  ${include_clause} ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_class'::regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname
\gexec
SELECT format(
         CASE WHEN relation.relkind IN ('r', 'p')
           THEN 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I;'
           ELSE 'GRANT SELECT ON TABLE %I.%I TO %I;'
         END,
         namespace.nspname, relation.relname, '${TARGET_RUNTIME_ROLE}')
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p', 'v', 'm')
  ${runtime_include_clause} ${exclude_clause}
  AND NOT (
    relation.relname = '__drizzle_migrations'
    AND namespace.nspname IN ('public', 'drizzle')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_class'::regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM PUBLIC, %I;',
              namespace.nspname, relation.relname, '${TARGET_RUNTIME_ROLE}')
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_depend AS ownership
  ON ownership.classid = 'pg_class'::regclass
 AND ownership.objid = relation.oid
 AND ownership.refclassid = 'pg_class'::regclass
 AND ownership.deptype IN ('a', 'i')
 AND ownership.refobjsubid > 0
LEFT JOIN pg_class AS owner_table ON owner_table.oid = ownership.refobjid
LEFT JOIN pg_namespace AS owner_namespace ON owner_namespace.oid = owner_table.relnamespace
WHERE relation.relkind = 'S'
  ${include_clause} ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_class'::regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname
\gexec

SELECT format('GRANT USAGE ON SEQUENCE %I.%I TO %I;',
              namespace.nspname, relation.relname, '${TARGET_RUNTIME_ROLE}')
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_depend AS ownership
  ON ownership.classid = 'pg_class'::regclass
 AND ownership.objid = relation.oid
 AND ownership.refclassid = 'pg_class'::regclass
 AND ownership.deptype IN ('a', 'i')
 AND ownership.refobjsubid > 0
LEFT JOIN pg_class AS owner_table ON owner_table.oid = ownership.refobjid
LEFT JOIN pg_namespace AS owner_namespace ON owner_namespace.oid = owner_table.relnamespace
WHERE relation.relkind = 'S'
  ${runtime_include_clause} ${exclude_clause}
  AND NOT (
    owner_table.relname = '__drizzle_migrations'
    AND owner_namespace.nspname IN ('public', 'drizzle')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_class'::regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON ROUTINE %s FROM PUBLIC, %I;',
              procedure.oid::regprocedure, '${TARGET_RUNTIME_ROLE}')
FROM pg_proc AS procedure
JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE true ${include_clause} ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_proc'::regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, procedure.proname, procedure.oid
\gexec

SELECT format('GRANT EXECUTE ON ROUTINE %s TO %I;',
              procedure.oid::regprocedure, '${TARGET_RUNTIME_ROLE}')
FROM pg_proc AS procedure
JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE true ${runtime_include_clause} ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_proc'::regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, procedure.proname, procedure.oid
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON TYPE %I.%I FROM PUBLIC, %I;',
              namespace.nspname, type_row.typname, '${TARGET_RUNTIME_ROLE}')
FROM pg_type AS type_row
JOIN pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
-- Multiranges inherit the owning range ACL and reject direct GRANT.
WHERE type_row.typtype IN ('c', 'd', 'e', 'r')
  AND (type_row.typrelid = 0 OR EXISTS (
    SELECT 1 FROM pg_class AS composite_relation
    WHERE composite_relation.oid = type_row.typrelid AND composite_relation.relkind = 'c'
  ))
  ${include_clause} ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_type'::regclass
      AND extension_dependency.objid = type_row.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, type_row.typname
\gexec


SELECT format('GRANT USAGE ON TYPE %I.%I TO %I;',
              namespace.nspname, type_row.typname, '${TARGET_RUNTIME_ROLE}')
FROM pg_type AS type_row
JOIN pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
WHERE type_row.typtype IN ('c', 'd', 'e', 'r')
  AND (type_row.typrelid = 0 OR EXISTS (
    SELECT 1 FROM pg_class AS composite_relation
    WHERE composite_relation.oid = type_row.typrelid AND composite_relation.relkind = 'c'
  ))
  ${runtime_include_clause} ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_type'::regclass
      AND extension_dependency.objid = type_row.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, type_row.typname
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM PUBLIC, %I; ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM PUBLIC, %I; ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON ROUTINES FROM PUBLIC, %I; ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TYPES FROM PUBLIC, %I;',
              '${TARGET_OWNER_ROLE}', '${TARGET_RUNTIME_ROLE}',
              '${TARGET_OWNER_ROLE}', '${TARGET_RUNTIME_ROLE}',
              '${TARGET_OWNER_ROLE}', '${TARGET_RUNTIME_ROLE}',
              '${TARGET_OWNER_ROLE}', '${TARGET_RUNTIME_ROLE}')
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM PUBLIC, %I;',
              '${TARGET_OWNER_ROLE}', namespace.nspname, '${TARGET_RUNTIME_ROLE}')
FROM pg_namespace AS namespace WHERE true ${include_clause} ${exclude_clause}
ORDER BY namespace.nspname
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM PUBLIC, %I;',
              '${TARGET_OWNER_ROLE}', namespace.nspname, '${TARGET_RUNTIME_ROLE}')
FROM pg_namespace AS namespace WHERE true ${include_clause} ${exclude_clause}
ORDER BY namespace.nspname
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON ROUTINES FROM PUBLIC, %I;',
              '${TARGET_OWNER_ROLE}', namespace.nspname, '${TARGET_RUNTIME_ROLE}')
FROM pg_namespace AS namespace WHERE true ${include_clause} ${exclude_clause}
ORDER BY namespace.nspname
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT EXECUTE ON ROUTINES TO %I;',
              '${TARGET_OWNER_ROLE}', namespace.nspname, '${TARGET_RUNTIME_ROLE}')
FROM pg_namespace AS namespace WHERE true ${runtime_include_clause} ${exclude_clause}
ORDER BY namespace.nspname
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TYPES FROM PUBLIC, %I;',
              '${TARGET_OWNER_ROLE}', namespace.nspname, '${TARGET_RUNTIME_ROLE}')
FROM pg_namespace AS namespace WHERE true ${include_clause} ${exclude_clause}
ORDER BY namespace.nspname
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE ON TYPES TO %I;',
              '${TARGET_OWNER_ROLE}', namespace.nspname, '${TARGET_RUNTIME_ROLE}')
FROM pg_namespace AS namespace WHERE true ${runtime_include_clause} ${exclude_clause}
ORDER BY namespace.nspname
\gexec

DO \$runtime_acl\$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
    WHERE relation.relkind IN ('r', 'p', 'v', 'm')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege.grantee IN (
        0,
        (SELECT oid FROM pg_roles WHERE rolname = '${TARGET_RUNTIME_ROLE}')
      )
      ${include_clause} ${exclude_clause}
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend AS extension_dependency
        WHERE extension_dependency.classid = 'pg_class'::regclass
          AND extension_dependency.objid = relation.oid
          AND extension_dependency.deptype = 'e'
      )
  ) THEN
    RAISE EXCEPTION 'runtime/PUBLIC relation column ACLs remain after target reconciliation';
  END IF;
END
\$runtime_acl\$;
SQL
}

superuser_catalog_manifest() {
  local connection_name="$1"
  local include_clause exclude_clause sql
  include_clause="$(schema_include_clause 'namespace.nspname')"
  exclude_clause="$(schema_exclude_clause 'namespace.nspname')"
  sql="
WITH custom_family AS (
  SELECT family.*, namespace.nspname, access_method.amname
  FROM pg_opfamily AS family
  JOIN pg_namespace AS namespace ON namespace.oid = family.opfnamespace
  JOIN pg_am AS access_method ON access_method.oid = family.opfmethod
  WHERE true ${include_clause} ${exclude_clause}
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_opfamily'::regclass
        AND extension_dependency.objid = family.oid
        AND extension_dependency.deptype = 'e'
    )
), manifest(category, identity, definition) AS (
  SELECT 'operator_family', format('%I.%I/%I', family.nspname, family.opfname, family.amname), ''
  FROM custom_family AS family

  UNION ALL

  SELECT 'operator_class',
         format('%I.%I/%I', namespace.nspname, operator_class.opcname, access_method.amname),
         concat_ws('|', operator_class.opcdefault::text,
           format_type(operator_class.opcintype, NULL),
           format_type(operator_class.opckeytype, NULL),
           format('%I.%I', family.nspname, family.opfname))
  FROM pg_opclass AS operator_class
  JOIN pg_namespace AS namespace ON namespace.oid = operator_class.opcnamespace
  JOIN pg_am AS access_method ON access_method.oid = operator_class.opcmethod
  JOIN custom_family AS family ON family.oid = operator_class.opcfamily
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_opclass'::regclass
      AND extension_dependency.objid = operator_class.oid
      AND extension_dependency.deptype = 'e'
  )

  UNION ALL

  SELECT 'operator_family_operator',
         format('%I.%I/%I/%s/%s/%s', family.nspname, family.opfname, family.amname,
           family_operator.amopstrategy,
           format_type(family_operator.amoplefttype, NULL),
           format_type(family_operator.amoprighttype, NULL)),
         concat_ws('|', family_operator.amoppurpose,
           family_operator.amopopr::regoperator::text,
           coalesce(sort_namespace.nspname || '.' || sort_family.opfname, ''))
  FROM pg_amop AS family_operator
  JOIN custom_family AS family ON family.oid = family_operator.amopfamily
  LEFT JOIN pg_opfamily AS sort_family ON sort_family.oid = family_operator.amopsortfamily
  LEFT JOIN pg_namespace AS sort_namespace ON sort_namespace.oid = sort_family.opfnamespace

  UNION ALL

  SELECT 'operator_family_function',
         format('%I.%I/%I/%s/%s/%s', family.nspname, family.opfname, family.amname,
           family_function.amprocnum,
           format_type(family_function.amproclefttype, NULL),
           format_type(family_function.amprocrighttype, NULL)),
         family_function.amproc::regprocedure::text
  FROM pg_amproc AS family_function
  JOIN custom_family AS family ON family.oid = family_function.amprocfamily
)
SELECT json_build_array(category, identity, definition)::text
FROM manifest
ORDER BY category, identity, definition;"
  case "$connection_name" in
    source) psql_neon -X -Atq -c "$sql" ;;
    target) psql_railway -X -Atq -c "$sql" ;;
    *) fail "unknown superuser catalog connection $connection_name" ;;
  esac
}

assert_superuser_catalog_precreated() {
  local source_extension_manifest target_extension_manifest source_manifest target_manifest
  source_extension_manifest="$(psql_neon -X -Atq -c "
SELECT extension.extname || '|' || extension.extversion || '|' || namespace.nspname || '|' ||
       extension.extrelocatable::text
FROM pg_extension AS extension
JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
WHERE extension.extname <> 'plpgsql'
ORDER BY extension.extname;")"
  target_extension_manifest="$(psql_railway -X -Atq -c "
SELECT extension.extname || '|' || extension.extversion || '|' || namespace.nspname || '|' ||
       extension.extrelocatable::text
FROM pg_extension AS extension
JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
WHERE extension.extname <> 'plpgsql'
ORDER BY extension.extname;")"
  if [[ "$source_extension_manifest" != "$target_extension_manifest" ]]; then
    diff -u \
      <(printf '%s\n' "$source_extension_manifest") \
      <(printf '%s\n' "$target_extension_manifest") >&2 || true
    fail "every source extension must be pre-created at the exact version/schema/relocatability on the target"
  fi

  source_manifest="$(superuser_catalog_manifest source)"
  target_manifest="$(superuser_catalog_manifest target)"
  if [[ "$source_manifest" != "$target_manifest" ]]; then
    diff -u \
      <(printf '%s\n' "$source_manifest") \
      <(printf '%s\n' "$target_manifest") >&2 || true
    fail "custom operator families/classes are superuser-only and must be pre-created identically on the target before restricted schema restore"
  fi
}

assert_subscription_contract() {
  # Validate the role boundary independently first. The exact catalog query
  # below is the single authority for whether the expected subscription is
  # present, enabled, and owned by that role.
  #
  # Teardown passes skip-subscriber-role-shape. Dropping a subscription, slot
  # and publication never touches the role, so the role's ACL shape cannot make
  # that unsafe -- and gating on it would strand the WAL-emergency path exactly
  # when the slot is filling the source disk. Identity is still proven, by the
  # subowner/name/slot/publication equality in the query below. The full role
  # contract is still enforced where it decides a DROP ROLE, in
  # drop_target_subscriber_role.
  local subscriber_role_check="${1:-validate-subscriber-role}"
  [[ "$subscriber_role_check" =~ ^(validate-subscriber-role|skip-subscriber-role-shape)$ ]] ||
    fail "internal subscriber role check must be validate-subscriber-role or skip-subscriber-role-shape"
  if [[ "$subscriber_role_check" == 'validate-subscriber-role' ]]; then
    validate_target_subscriber_role optional
  fi

  [[ "$PUBLISHER_CONNINFO_DIGEST" =~ ^[0-9a-f]{32}$ &&
    "$PUBLISHER_REDACTED_CONNINFO_DIGEST" =~ ^[0-9a-f]{32}$ ]] ||
    fail "prepare the canonical publisher connection before verifying the subscription contract"

  local contract_matches
  contract_matches="$(psql_railway -X -Atq -c "
SELECT count(*) = 1
FROM pg_subscription AS subscription
WHERE subscription.subname = '${SUBSCRIPTION_NAME}'
  AND pg_get_userbyid(subscription.subowner) = '${TARGET_SUBSCRIBER_ROLE}'
  AND subscription.subenabled
  AND NOT subscription.subbinary
  AND subscription.suborigin = 'none'
  AND NOT subscription.subrunasowner
  AND subscription.subpasswordrequired
  AND NOT subscription.subfailover
  AND subscription.subslotname = '${SLOT_NAME}'
  AND subscription.subpublications = ARRAY['${PUBLICATION_NAME}']::text[]
  AND md5(subscription.subconninfo) = '${PUBLISHER_CONNINFO_DIGEST}'
  AND obj_description(subscription.oid, 'pg_subscription') =
      'boardsesh-pg18-conninfo-v1:${PUBLISHER_REDACTED_CONNINFO_DIGEST}';")"
  [[ "$contract_matches" == 't' ]] ||
    fail "subscription $SUBSCRIPTION_NAME does not match the exact owner/options/publication/slot/canonical connection contract"

  local source_manifest target_manifest
  source_manifest="$(publication_table_manifest)"
  target_manifest="$(psql_railway -X -Atq -c "
SELECT format('%I.%I', namespace.nspname, relation.relname)
FROM pg_subscription_rel AS subscription_relation
JOIN pg_subscription AS subscription ON subscription.oid = subscription_relation.srsubid
JOIN pg_class AS relation ON relation.oid = subscription_relation.srrelid
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE subscription.subname = '${SUBSCRIPTION_NAME}'
ORDER BY 1;")"

  if [[ "$source_manifest" != "$target_manifest" ]]; then
    diff -u \
      <(printf '%s\n' "$source_manifest") \
      <(printf '%s\n' "$target_manifest") >&2 || true
    fail "subscription table coverage differs from the source manifest; REFRESH PUBLICATION WITH (copy_data=true), re-audit, or restart the rehearsal"
  fi
}

publication_definition_manifest() {
  local include_clause exclude_clause
  include_clause="$(schema_include_clause 'namespace.nspname')"
  exclude_clause="$(schema_exclude_clause 'namespace.nspname')"
  psql_neon -X -Atq -c "
SELECT format('%I.%I', namespace.nspname, relation.relname)
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND relation.relpersistence = 'p'
  AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND namespace.nspname !~ '^pg_toast'
  ${include_clause}
  ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1
    FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_class'::regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY 1;"
}

target_publication_definition_manifest() {
  local include_clause exclude_clause
  include_clause="$(schema_include_clause 'namespace.nspname')"
  exclude_clause="$(schema_exclude_clause 'namespace.nspname')"
  psql_railway -X -Atq -c "
SELECT format('%I.%I', namespace.nspname, relation.relname)
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND relation.relpersistence = 'p'
  AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND namespace.nspname !~ '^pg_toast'
  ${include_clause}
  ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1
    FROM pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_class'::regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY 1;"
}

assert_target_schema_and_table_manifest() {
  local schema requested_values='' missing_schema_count source_manifest target_manifest
  for schema in $INCLUDE_SCHEMAS; do
    requested_values+="${requested_values:+, }('$schema')"
  done
  missing_schema_count="$(psql_railway -X -Atq -c "
SELECT count(*)
FROM (VALUES ${requested_values}) AS requested(schema_name)
WHERE pg_catalog.to_regnamespace(requested.schema_name) IS NULL;")"
  [[ "$missing_schema_count" == '0' ]] ||
    fail "target is missing $missing_schema_count schema(s) named by INCLUDE_SCHEMAS"

  source_manifest="$(publication_definition_manifest)"
  target_manifest="$(target_publication_definition_manifest)"
  if [[ "$source_manifest" != "$target_manifest" ]]; then
    diff -u \
      <(printf '%s\n' "$source_manifest") \
      <(printf '%s\n' "$target_manifest") >&2 || true
    fail 'target table manifest differs from the exact source publication manifest'
  fi
}

assert_publication_contract() {
  local publication_contract expected_manifest actual_manifest
  publication_contract="$(psql_neon -X -Atq -c "
SELECT count(*) = 1
FROM pg_publication AS publication
WHERE publication.pubname = '${PUBLICATION_NAME}'
  AND pg_get_userbyid(publication.pubowner) = current_user
  AND NOT publication.puballtables
  AND publication.pubinsert
  AND publication.pubupdate
  AND publication.pubdelete
  AND publication.pubtruncate
  AND NOT publication.pubviaroot;")"
  [[ "$publication_contract" == 't' ]] ||
    fail "publication $PUBLICATION_NAME does not match the exact owner/options contract"

  expected_manifest="$(publication_definition_manifest)"
  actual_manifest="$(psql_neon -X -Atq -c "
SELECT format('%I.%I', namespace.nspname, relation.relname)
FROM pg_publication_rel AS publication_relation
JOIN pg_publication AS publication ON publication.oid = publication_relation.prpubid
JOIN pg_class AS relation ON relation.oid = publication_relation.prrelid
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE publication.pubname = '${PUBLICATION_NAME}'
ORDER BY 1;")"
  if [[ "$expected_manifest" != "$actual_manifest" ]]; then
    diff -u \
      <(printf '%s\n' "$expected_manifest") \
      <(printf '%s\n' "$actual_manifest") >&2 || true
    fail "publication $PUBLICATION_NAME does not contain the exact included non-extension table manifest"
  fi
}

publication_table_list() {
  local include_clause exclude_clause
  include_clause="$(schema_include_clause 'n.nspname')"
  exclude_clause="$(schema_exclude_clause 'n.nspname')"
  psql_neon -At <<SQL
SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND c.relpersistence = 'p'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname !~ '^pg_toast'
  ${include_clause}
  ${exclude_clause}
  AND NOT EXISTS (
    SELECT 1
    FROM pg_depend d
    WHERE d.classid = 'pg_class'::regclass
      AND d.objid = c.oid
      AND d.deptype = 'e'
  );
SQL
}

assert_railway_target_tables_empty() {
  local include_clause exclude_clause
  include_clause="$(schema_include_clause 'n.nspname')"
  exclude_clause="$(schema_exclude_clause 'n.nspname')"
  psql_railway <<SQL
DO \$\$
DECLARE
  rel record;
  has_rows boolean;
BEGIN
  FOR rel IN
    SELECT format('%I.%I', n.nspname, c.relname) AS relation_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND c.relpersistence = 'p'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname !~ '^pg_toast'
      ${include_clause}
      ${exclude_clause}
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
    ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM ' || rel.relation_name || ')' INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'Railway target table % is not empty; copy_data=true requires empty target tables', rel.relation_name;
    END IF;
  END LOOP;
END
\$\$;
SQL
}

check_common_requirements() {
  require_env NEON_DATABASE_URL
  require_env RAILWAY_DATABASE_URL
  require_command psql
  validate_schema_policy_lists
  prepare_common_connections
  local source_database_name target_database_name
  source_database_name="$(psql_neon -X -Atq -c 'SELECT current_database();')"
  target_database_name="$(psql_railway -X -Atq -c 'SELECT current_database();')"
  [[ "$source_database_name" == "$SOURCE_DATABASE_NAME" ]] ||
    fail "source database is $source_database_name; expected canonical database $SOURCE_DATABASE_NAME"
  [[ "$target_database_name" == "$TARGET_DATABASE_NAME" ]] ||
    fail "target database is $target_database_name; expected canonical database $TARGET_DATABASE_NAME"
  require_identifier PUBLICATION_NAME "$PUBLICATION_NAME"
  require_identifier SUBSCRIPTION_NAME "$SUBSCRIPTION_NAME"
  require_identifier SLOT_NAME "$SLOT_NAME"
  assert_source_schema_manifest
}

setup_replication() {
  check_common_requirements
  require_env NEON_REPLICATION_DATABASE_URL
  prepare_publisher_connection
  require_env TARGET_OWNER_ROLE
  require_identifier TARGET_OWNER_ROLE "$TARGET_OWNER_ROLE"
  require_env TARGET_MIGRATOR_ROLE
  require_identifier TARGET_MIGRATOR_ROLE "$TARGET_MIGRATOR_ROLE"
  require_env TARGET_SUBSCRIBER_ROLE
  require_identifier TARGET_SUBSCRIBER_ROLE "$TARGET_SUBSCRIBER_ROLE"
  require_command pg_dump
  require_command pg_restore
  require_command awk

  local wal_level
  wal_level="$(psql_neon -Atqc 'SHOW wal_level;')"
  [[ "$wal_level" == "logical" ]] || fail "Neon wal_level is '$wal_level'; enable logical replication first"

  validate_publisher_credential
  assert_no_source_column_acls

  local target_owner_contract
  target_owner_contract="$(psql_railway -Atq -c "
WITH owner_role AS (
  SELECT * FROM pg_roles WHERE rolname = '${TARGET_OWNER_ROLE}'
)
SELECT count(*) = 1
FROM owner_role
WHERE NOT rolcanlogin
  AND NOT rolsuper
  AND NOT rolcreatedb
  AND NOT rolcreaterole
  AND rolinherit
  AND NOT rolreplication
  AND NOT rolbypassrls
  AND NOT EXISTS (
    SELECT 1 FROM pg_database AS database
    WHERE database.datdba = owner_role.oid
  )
  AND (
    SELECT count(*) = 1
      AND bool_and(
        privilege.privilege_type = 'CREATE'
        AND NOT privilege.is_grantable
      )
    FROM pg_database AS database
    CROSS JOIN LATERAL aclexplode(database.datacl) AS privilege
    WHERE database.datname = current_database()
      AND privilege.grantee = owner_role.oid
  )
  AND (
    SELECT count(*) = 2 AND bool_and(
      member_role.rolname IN ('${TARGET_MIGRATOR_ROLE}', '${TARGET_SUBSCRIBER_ROLE}')
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
    )
    FROM pg_auth_members AS membership
    JOIN pg_roles AS member_role ON member_role.oid = membership.member
    WHERE membership.roleid = owner_role.oid
  );")"
  [[ "$target_owner_contract" == "t" ]] ||
    fail "TARGET_OWNER_ROLE must match the exact restricted NOLOGIN/database-CREATE contract with only the expected migrator and subscriber incoming SET-only edges"
  validate_snapshot_fence_owner_role
  validate_target_migrator_role
  validate_target_subscriber_role
  require_env TARGET_RUNTIME_ROLE
  # Migration 0200 creates a privileged target-only ops contract. Restoring it
  # through this generic --no-acl path would lose its exact owner and grants,
  # and table triggers could arrive without their SECURITY DEFINER functions.
  # Keep it strictly after logical cutover instead of widening runtime access.
  assert_source_precedes_snapshot_fence_migration

  # A retry that skips schema restore must prove the prior attempt left the
  # complete local relation manifest before any target extension/ACL mutation.
  # Otherwise CREATE SUBSCRIPTION could create its remote slot and only then
  # discover a missing local relation.
  if [[ "$LOAD_SCHEMA" == 'false' ]]; then
    assert_target_schema_and_table_manifest
  fi

  local source_hypopg_count
  source_hypopg_count="$(psql_neon -X -Atq -c "
SELECT count(*) FROM pg_extension WHERE extname = 'hypopg';")"
  [[ "$source_hypopg_count" == '0' || "$source_hypopg_count" == '1' ]] ||
    fail "source HypoPG extension manifest is ambiguous"

  echo "Creating required Railway extensions..."
  if ! psql_railway <<'SQL'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL
  then
    fail "failed to create required extensions on Railway; use a Railway Postgres image/template that includes PostGIS"
  fi
  if [[ "$source_hypopg_count" == '1' ]]; then
    psql_railway -c 'CREATE EXTENSION IF NOT EXISTS hypopg;'
  fi

  assert_superuser_catalog_precreated

  if [[ "$LOAD_SCHEMA" == "true" ]]; then
    local dump_file restore_list filtered_restore_list restore_stderr schema
    local -a schema_dump_args=()
    dump_file="$OPERATION_TEMP_DIR/schema.dump"
    restore_list="$OPERATION_TEMP_DIR/schema.list"
    filtered_restore_list="$OPERATION_TEMP_DIR/schema-filtered.list"
    restore_stderr="$OPERATION_TEMP_DIR/schema-restore.stderr"

    for schema in $INCLUDE_SCHEMAS; do
      require_identifier INCLUDE_SCHEMAS "$schema"
      schema_dump_args+=("--schema=$schema")
    done

    echo "Dumping Neon schema only..."
    boardsesh_run_libpq_connection SOURCE \
      pg_dump --schema-only --no-owner --no-acl --no-publications --no-subscriptions \
        "${schema_dump_args[@]}" --format=custom --file "$dump_file"

    # Extensions and any exact custom operator family/class manifest are
    # pre-created by the target admin. Application schemas are also pre-created
    # below because public already contains extension members. Filter those
    # entries, including COMMENT commands which cannot run as the app owner.
    boardsesh_run_libpq_connection TARGET pg_restore --list "$dump_file" >"$restore_list"
    awk '$0 !~ / SCHEMA - / && $0 !~ / EXTENSION - / && $0 !~ / COMMENT - EXTENSION / && $0 !~ / OPERATOR FAMILY / && $0 !~ / OPERATOR CLASS / { print }' \
      "$restore_list" >"$filtered_restore_list"

    for schema in $INCLUDE_SCHEMAS; do
      psql_railway -c "CREATE SCHEMA IF NOT EXISTS \"$schema\" AUTHORIZATION \"$TARGET_OWNER_ROLE\";"
      psql_railway -c "ALTER SCHEMA \"$schema\" OWNER TO \"$TARGET_OWNER_ROLE\";"
    done

    echo "Restoring schema to Railway..."
    if ! boardsesh_run_libpq_connection TARGET \
      pg_restore --exit-on-error --schema-only --no-owner --no-acl \
        --role "$TARGET_OWNER_ROLE" --use-list "$filtered_restore_list" \
        --dbname "${BOARDSESH_LIBPQ_TARGET_PGDATABASE}" "$dump_file" 2>"$restore_stderr"; then
      cat "$restore_stderr" >&2
      fail "schema restore failed; the target must be recreated or reconciled before retrying"
    fi
    if [[ -s "$restore_stderr" ]]; then
      cat "$restore_stderr" >&2
      fail "schema restore reported diagnostics; treat every restore warning as a failed migration gate"
    fi
    rm -f "$dump_file" "$restore_list" "$filtered_restore_list" "$restore_stderr"
  else
    echo "Skipping schema load because LOAD_SCHEMA=false."
  fi

  echo "Reconstructing the target runtime ACL policy omitted by --no-acl..."
  apply_target_routine_ownership_policy
  apply_target_runtime_acl_policy
  assert_target_schema_and_table_manifest

  # CREATE SUBSCRIPTION resolves each local publication table while running as
  # the dedicated subscription owner. Schema USAGE is required for that catalog
  # registration step; row application still SET ROLEs to TARGET_OWNER_ROLE.
  grant_target_subscriber_schema_usage

  echo "Verifying Railway target tables are empty..."
  assert_railway_target_tables_empty

  local table_list
  table_list="$(publication_table_list)"
  [[ -n "$table_list" ]] || fail "no publishable Neon tables found"

  local pub_all_tables
  pub_all_tables="$(psql_neon -Atq -c "SELECT puballtables FROM pg_publication WHERE pubname = '$PUBLICATION_NAME';")"
  if [[ "$pub_all_tables" == "t" ]]; then
    fail "Neon publication '$PUBLICATION_NAME' already exists as FOR ALL TABLES; drop it first so extension tables are not replicated"
  elif [[ "$pub_all_tables" == "f" ]]; then
    local publication_contract
    publication_contract="$(psql_neon -Atq -c "
SELECT pubinsert AND pubupdate AND pubdelete AND pubtruncate AND NOT pubviaroot
FROM pg_publication
WHERE pubname = '$PUBLICATION_NAME';")"
    [[ "$publication_contract" == 't' ]] ||
      fail "existing publication must publish insert/update/delete/truncate with publish_via_partition_root=false"
    echo "Updating Neon publication table list..."
    psql_neon <<SQL
ALTER PUBLICATION $PUBLICATION_NAME SET TABLE $table_list;
SQL
  else
    echo "Creating Neon publication..."
    psql_neon <<SQL
CREATE PUBLICATION $PUBLICATION_NAME FOR TABLE $table_list;
SQL
  fi
  assert_publication_contract

  local subscription_exists
  subscription_exists="$(psql_railway -Atq -c "SELECT 1 FROM pg_subscription WHERE subname = '$SUBSCRIPTION_NAME';")"
  if [[ "$subscription_exists" == "1" ]]; then
    assert_subscription_contract
    echo "Railway subscription '$SUBSCRIPTION_NAME' already exists and its exact catalog contract matches."
  else
    echo "Creating Railway subscription with copy_data=true..."
    local publisher_conninfo publisher_conninfo_literal subscription_sql_file
    publisher_conninfo="$(<"$PUBLISHER_CONNINFO_FILE")"
    publisher_conninfo_literal="${publisher_conninfo//\'/\'\'}"
    subscription_sql_file="$OPERATION_TEMP_DIR/create-subscription.sql"
    printf '%s\n' \
      'SET standard_conforming_strings = on;' \
      "SET ROLE \"$TARGET_SUBSCRIBER_ROLE\";" \
      "CREATE SUBSCRIPTION $SUBSCRIPTION_NAME" \
      "  CONNECTION '$publisher_conninfo_literal'" \
      "  PUBLICATION $PUBLICATION_NAME" \
      '  WITH (' \
      '    copy_data = true,' \
      '    create_slot = true,' \
      "    slot_name = '$SLOT_NAME'," \
      '    enabled = true,' \
      '    binary = false,' \
      '    origin = none,' \
      '    run_as_owner = false,' \
      '    password_required = true,' \
      '    failover = false' \
      '  );' \
      "COMMENT ON SUBSCRIPTION $SUBSCRIPTION_NAME IS 'boardsesh-pg18-conninfo-v1:${PUBLISHER_REDACTED_CONNINFO_DIGEST}';" \
      'RESET ROLE;' >"$subscription_sql_file"
    chmod 0600 "$subscription_sql_file"
    psql_railway --file "$subscription_sql_file"
    rm -f "$subscription_sql_file"
    unset publisher_conninfo publisher_conninfo_literal
    assert_subscription_contract
  fi

  echo "Setup complete. Run '$0 status' until Railway is caught up."
}

status_replication() {
  check_common_requirements
  require_env NEON_REPLICATION_DATABASE_URL
  prepare_publisher_connection
  assert_subscription_contract
  assert_publication_contract

  echo "Neon publisher connections:"
  psql_neon -x -v sub_name="$SUBSCRIPTION_NAME" <<'SQL'
SELECT application_name, state, sent_lsn, write_lsn, flush_lsn, replay_lsn, sync_state
FROM pg_stat_replication
WHERE application_name = :'sub_name';
SQL

  echo
  echo "Railway subscription status:"
  psql_railway -x -v sub_name="$SUBSCRIPTION_NAME" <<'SQL'
SELECT subname, pid, received_lsn, latest_end_lsn, latest_end_time,
       now() - latest_end_time AS replication_lag
FROM pg_stat_subscription
WHERE subname = :'sub_name';
SQL

  echo
  echo "Railway table sync states:"
  psql_railway -v sub_name="$SUBSCRIPTION_NAME" <<'SQL'
SELECT srsubstate, count(*) AS table_count
FROM pg_subscription_rel
WHERE srsubid = (SELECT oid FROM pg_subscription WHERE subname = :'sub_name')
GROUP BY srsubstate
ORDER BY srsubstate;
SQL

  echo
  echo "Row count comparison:"
  for table in $CHECK_TABLES; do
    require_identifier CHECK_TABLES "$table"
    local neon_count railway_count
    neon_count="$(psql_neon -Atqc "SELECT count(*) FROM \"$table\";")"
    railway_count="$(psql_railway -Atqc "SELECT count(*) FROM \"$table\";")"
    printf '%-28s Neon=%-12s Railway=%-12s\n' "$table" "$neon_count" "$railway_count"
  done
}

sync_sequences() {
  check_common_requirements
  require_env NEON_REPLICATION_DATABASE_URL
  prepare_publisher_connection
  assert_subscription_contract
  assert_publication_contract
  [[ "${WRITES_FENCED:-false}" == "true" ]] ||
    fail "sync-sequences requires WRITES_FENCED=true after every Neon writer has been stopped and fenced"
  [[ -n "${FENCED_WRITER_ROLES:-}" ]] ||
    fail "FENCED_WRITER_ROLES must list every app, sync, and migrator writer role"

  local writer_roles_sql
  writer_roles_sql="$(quoted_role_list)"
  local -a writer_roles
  read -r -a writer_roles <<<"$FENCED_WRITER_ROLES"
  local existing_writer_roles unfenced_roles active_writer_sessions
  existing_writer_roles="$(psql_neon -Atq -c "
SELECT count(*) FROM pg_roles WHERE rolname IN (${writer_roles_sql});")"
  [[ "$existing_writer_roles" == "${#writer_roles[@]}" ]] ||
    fail "FENCED_WRITER_ROLES contains a role that does not exist on the source"
  unfenced_roles="$(psql_neon -Atq -c "
SELECT count(*) FROM pg_roles
WHERE rolname IN (${writer_roles_sql}) AND rolcanlogin;")"
  [[ "$unfenced_roles" == "0" ]] ||
    fail "$unfenced_roles source writer role(s) still have LOGIN; fence with ALTER ROLE ... NOLOGIN"

  active_writer_sessions="$(psql_neon -Atq -c "
SELECT count(*) FROM pg_stat_activity
WHERE usename IN (${writer_roles_sql}) AND pid <> pg_backend_pid();")"
  [[ "$active_writer_sessions" == "0" ]] ||
    fail "$active_writer_sessions source writer session(s) remain active; terminate them before sequence sync"

  local nonready_tables
  nonready_tables="$(psql_railway -Atq -c "
SELECT count(*)
FROM pg_subscription_rel
WHERE srsubid = (SELECT oid FROM pg_subscription WHERE subname = '${SUBSCRIPTION_NAME}')
  AND srsubstate <> 'r';")"
  [[ "$nonready_tables" == "0" ]] ||
    fail "$nonready_tables subscription table(s) are not in ready state"

  local source_flush_lsn target_caught_up
  source_flush_lsn="$(psql_neon -Atq -c 'SELECT pg_current_wal_flush_lsn();')"
  target_caught_up="$(psql_railway -Atq -c "
SELECT count(*) = 1
FROM pg_stat_subscription
WHERE subname = '${SUBSCRIPTION_NAME}'
  AND pid IS NOT NULL
  AND latest_end_lsn IS NOT NULL
  AND pg_wal_lsn_diff(latest_end_lsn, '${source_flush_lsn}'::pg_lsn) >= 0;")"
  [[ "$target_caught_up" == "t" ]] ||
    fail "Railway subscription has not replayed the source flush LSN ${source_flush_lsn}"

  local sql_file target_sql_file
  sql_file="$OPERATION_TEMP_DIR/sequences.sql"
  target_sql_file="$OPERATION_TEMP_DIR/target-sequences.sql"

  local included_schemas excluded_schemas
  included_schemas="$(included_schemas_csv)"
  excluded_schemas="$(excluded_schemas_csv)"

  echo "Generating owned-sequence setval statements from Neon sequence relations..."
  psql_neon -X -Atq \
    -v included_schemas="$included_schemas" \
    -v excluded_schemas="$excluded_schemas" \
    --file "$SCRIPT_DIR/postgres-owned-sequence-setvals.sql" >"$sql_file"
  [[ -s "$sql_file" ]] ||
    fail "no owned-sequence state was generated; keep writers fenced and verify INCLUDE_SCHEMAS coverage"

  echo "Applying sequence values to Railway in one transaction..."
  psql_railway -X --single-transaction --file "$sql_file"

  psql_railway -X -Atq \
    -v included_schemas="$included_schemas" \
    -v excluded_schemas="$excluded_schemas" \
    --file "$SCRIPT_DIR/postgres-owned-sequence-setvals.sql" >"$target_sql_file"
  if ! cmp -s "$sql_file" "$target_sql_file"; then
    fail "Railway owned-sequence state does not match Neon after synchronization; keep writers fenced and investigate"
  fi
  rm -f "$sql_file" "$target_sql_file"
  echo "Sequence sync complete."
}

# The temporary cutover credential is the last replication object to go. It keeps
# a second SET-only edge into TARGET_OWNER_ROLE, and the reserved migrator's exact
# incoming-edge check stays red for as long as that edge exists, so leaving the
# role behind quietly breaks every later restricted migration. Drop it only once
# the subscription, slot, and publication are provably gone, and only when the
# role still matches the exact identity setup asserted before it was used. Any
# other role wearing this name belongs to somebody else and must survive.
drop_target_subscriber_role() {
  # The two role names are demanded here rather than at the top of teardown so
  # the WAL-emergency path in the runbook (drop the orphan slot and publication
  # from a shell that only still has the connection URLs and object names) keeps
  # working. Role cleanup is the only step that cannot be done without them.
  [[ -n "${TARGET_OWNER_ROLE:-}" && -n "${TARGET_SUBSCRIBER_ROLE:-}" ]] ||
    fail "the replication objects are gone; export TARGET_OWNER_ROLE and TARGET_SUBSCRIBER_ROLE and re-run teardown to remove the temporary subscriber role"
  require_env TARGET_OWNER_ROLE
  require_env TARGET_SUBSCRIBER_ROLE
  require_identifier TARGET_OWNER_ROLE "$TARGET_OWNER_ROLE"
  require_identifier TARGET_SUBSCRIBER_ROLE "$TARGET_SUBSCRIBER_ROLE"
  [[ "$TARGET_SUBSCRIBER_ROLE" != "$TARGET_OWNER_ROLE" ]] ||
    fail "TARGET_SUBSCRIBER_ROLE must not name TARGET_OWNER_ROLE"
  [[ -z "${TARGET_MIGRATOR_ROLE:-}" || "$TARGET_SUBSCRIBER_ROLE" != "$TARGET_MIGRATOR_ROLE" ]] ||
    fail "TARGET_SUBSCRIBER_ROLE must not name TARGET_MIGRATOR_ROLE"

  local subscriber_role_count
  subscriber_role_count="$(psql_railway -X -Atq -c "
SELECT count(*) FROM pg_roles AS subscriber WHERE subscriber.rolname = '${TARGET_SUBSCRIBER_ROLE}';")"
  if [[ "$subscriber_role_count" == '0' ]]; then
    echo "Temporary subscriber role '$TARGET_SUBSCRIBER_ROLE' does not exist; nothing to clean up."
    return
  fi
  [[ "$subscriber_role_count" == '1' ]] ||
    fail "target reports $subscriber_role_count roles named $TARGET_SUBSCRIBER_ROLE"

  echo "Verifying '$TARGET_SUBSCRIBER_ROLE' still matches the exact temporary-subscriber contract; teardown refuses to drop any other role."
  validate_target_subscriber_role absent

  echo "Dropping the temporary subscriber role '$TARGET_SUBSCRIBER_ROLE'..."
  psql_railway -X --single-transaction <<SQL
SELECT format('REVOKE %I FROM %I;', granted_role.rolname, '$TARGET_SUBSCRIBER_ROLE')
FROM pg_auth_members AS membership
JOIN pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname = '$TARGET_SUBSCRIBER_ROLE'
ORDER BY granted_role.rolname
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I;',
              current_database(), '$TARGET_SUBSCRIBER_ROLE')
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I;',
              namespace.nspname, '$TARGET_SUBSCRIBER_ROLE')
FROM pg_namespace AS namespace
WHERE namespace.nspname <> 'information_schema'
  AND namespace.nspname !~ '^pg_'
ORDER BY namespace.nspname
\gexec
-- The contract above already proved the role owns nothing, so this cannot drop
-- an object. It is here to sweep any residual object-level ACL entry that DROP
-- ROLE would otherwise refuse on, inside the same all-or-nothing transaction.
SELECT format('DROP OWNED BY %I;', '$TARGET_SUBSCRIBER_ROLE')
\gexec
SELECT format('DROP ROLE %I;', '$TARGET_SUBSCRIBER_ROLE')
\gexec
SQL

  subscriber_role_count="$(psql_railway -X -Atq -c "
SELECT count(*) FROM pg_roles AS subscriber WHERE subscriber.rolname = '${TARGET_SUBSCRIBER_ROLE}';")"
  [[ "$subscriber_role_count" == '0' ]] ||
    fail "temporary subscriber role $TARGET_SUBSCRIBER_ROLE still exists after teardown"
  echo "Temporary subscriber role '$TARGET_SUBSCRIBER_ROLE' removed. Drop MIGRATION_SUBSCRIBER_ROLE and MIGRATION_SUBSCRIPTION_NAME from the deploy environment now."
}

teardown_replication() {
  [[ "${TEARDOWN_CONFIRMED:-false}" == "true" ]] ||
    fail "teardown requires TEARDOWN_CONFIRMED=true after the 72-hour acceptance window and a successful PG18 restore drill"
  check_common_requirements
  require_env NEON_REPLICATION_DATABASE_URL
  prepare_publisher_connection
  # TARGET_OWNER_ROLE and TARGET_SUBSCRIBER_ROLE are deliberately not required
  # here. Dropping the subscription needs them (its owner is half the proof the
  # subscription is ours) and so does the role cleanup, and both demand them at
  # their own call site. Nothing about dropping an orphan slot or the source
  # publication does, and that is the emergency path an operator reaches for
  # while the source is retaining WAL.
  if [[ -n "${TARGET_OWNER_ROLE:-}" ]]; then
    require_identifier TARGET_OWNER_ROLE "$TARGET_OWNER_ROLE"
  fi
  if [[ -n "${TARGET_SUBSCRIBER_ROLE:-}" ]]; then
    require_identifier TARGET_SUBSCRIBER_ROLE "$TARGET_SUBSCRIBER_ROLE"
  fi

  # Resolve and validate every same-name object before the first mutation. A
  # stale or unrelated publication/subscription/slot must never be deleted by
  # a teardown invocation that happens to reuse these names.
  local subscription_exists publication_exists source_slot_exists source_slot_contract
  subscription_exists="$(psql_railway -Atq -c "SELECT 1 FROM pg_subscription WHERE subname = '$SUBSCRIPTION_NAME';")"
  publication_exists="$(psql_neon -Atq -c "SELECT 1 FROM pg_publication WHERE pubname = '$PUBLICATION_NAME';")"
  source_slot_exists="$(psql_neon -X -Atq -v slot_name="$SLOT_NAME" <<'SQL'
SELECT count(*) FROM pg_replication_slots WHERE slot_name = :'slot_name';
SQL
)"

  [[ -z "$subscription_exists" || "$subscription_exists" == '1' ]] ||
    fail "target has duplicate subscriptions named $SUBSCRIPTION_NAME"
  [[ -z "$publication_exists" || "$publication_exists" == '1' ]] ||
    fail "source has duplicate publications named $PUBLICATION_NAME"
  [[ "$source_slot_exists" == '0' || "$source_slot_exists" == '1' ]] ||
    fail "source has duplicate slots named $SLOT_NAME"

  if [[ "$subscription_exists" == "1" ]]; then
    [[ "$publication_exists" == '1' ]] ||
      fail "subscription $SUBSCRIPTION_NAME exists without the exact source publication; refusing teardown"
    [[ "$source_slot_exists" == '1' ]] ||
      fail "subscription $SUBSCRIPTION_NAME exists without source slot $SLOT_NAME; refusing teardown"
    [[ -n "${TARGET_OWNER_ROLE:-}" && -n "${TARGET_SUBSCRIBER_ROLE:-}" ]] ||
      fail "subscription $SUBSCRIPTION_NAME still exists; proving it belongs to this migration needs TARGET_SUBSCRIBER_ROLE, and finishing the run needs TARGET_OWNER_ROLE for the role cleanup. Export both. Slot- and publication-only cleanup needs neither"
    assert_subscription_contract skip-subscriber-role-shape
  fi
  if [[ "$publication_exists" == '1' ]]; then
    assert_publication_contract
  fi
  if [[ "$source_slot_exists" == '1' ]]; then
    source_slot_contract="$(psql_neon -X -Atq \
      -v slot_name="$SLOT_NAME" \
      -v subscription_name="$SUBSCRIPTION_NAME" \
      -v subscription_exists="${subscription_exists:+true}" <<'SQL'
SELECT count(*) = 1
FROM pg_replication_slots AS slot
WHERE slot.slot_name = :'slot_name'
  AND slot.slot_type = 'logical'
  AND slot.plugin = 'pgoutput'
  AND slot.database = current_database()
  AND (
    NOT slot.active
    OR (
      :'subscription_exists' = 'true'
      AND EXISTS (
        SELECT 1
        FROM pg_stat_replication AS replication
        WHERE replication.pid = slot.active_pid
          AND replication.application_name = :'subscription_name'
      )
    )
  );
SQL
)"
    [[ "$source_slot_contract" == 't' ]] ||
      fail "source slot $SLOT_NAME does not match the exact logical pgoutput/current-database/subscription contract"
  fi

  echo "Dropping Railway subscription if present..."
  if [[ "$subscription_exists" == "1" ]]; then
    psql_railway <<SQL
ALTER SUBSCRIPTION $SUBSCRIPTION_NAME DISABLE;
DROP SUBSCRIPTION $SUBSCRIPTION_NAME;
SQL
  else
    echo "Railway subscription '$SUBSCRIPTION_NAME' does not exist."
  fi

  # DROP SUBSCRIPTION normally removes its remote slot. A failed/partial prior
  # teardown can leave the exact migration slot orphaned, so verify and remove
  # it independently. Never touch any other slot.
  source_slot_exists="$(psql_neon -X -Atq -v slot_name="$SLOT_NAME" <<'SQL'
SELECT count(*) FROM pg_replication_slots WHERE slot_name = :'slot_name';
SQL
)"
  if [[ "$source_slot_exists" == '1' ]]; then
    source_slot_contract="$(psql_neon -X -Atq -v slot_name="$SLOT_NAME" <<'SQL'
SELECT count(*) = 1
FROM pg_replication_slots
WHERE slot_name = :'slot_name'
  AND slot_type = 'logical'
  AND plugin = 'pgoutput'
  AND database = current_database()
  AND NOT active;
SQL
)"
    [[ "$source_slot_contract" == 't' ]] ||
      fail "source slot $SLOT_NAME exists but is active or does not match the exact logical pgoutput/current-database contract"
    psql_neon -X -v slot_name="$SLOT_NAME" >/dev/null <<'SQL'
SELECT pg_drop_replication_slot(:'slot_name');
SQL
  elif [[ "$source_slot_exists" != '0' ]]; then
    fail "source has duplicate slots named $SLOT_NAME"
  fi

  source_slot_exists="$(psql_neon -X -Atq -v slot_name="$SLOT_NAME" <<'SQL'
SELECT count(*) FROM pg_replication_slots WHERE slot_name = :'slot_name';
SQL
)"
  [[ "$source_slot_exists" == '0' ]] || fail "source slot $SLOT_NAME still exists after teardown"

  echo "Dropping Neon publication if present..."
  if [[ "$publication_exists" == '1' ]]; then
    psql_neon -c "DROP PUBLICATION $PUBLICATION_NAME;"
  else
    echo "Neon publication '$PUBLICATION_NAME' does not exist."
  fi

  # Re-read all three objects instead of trusting the pre-mutation snapshot. The
  # temporary credential may only be removed once nothing can still replicate.
  local remaining_subscriptions remaining_publications remaining_slots
  remaining_subscriptions="$(psql_railway -X -Atq -c "
SELECT count(*) FROM pg_subscription WHERE subname = '$SUBSCRIPTION_NAME';")"
  remaining_publications="$(psql_neon -X -Atq -c "
SELECT count(*) FROM pg_publication WHERE pubname = '$PUBLICATION_NAME';")"
  remaining_slots="$(psql_neon -X -Atq -v slot_name="$SLOT_NAME" <<'SQL'
SELECT count(*) FROM pg_replication_slots WHERE slot_name = :'slot_name';
SQL
)"
  [[ "$remaining_subscriptions" == '0' ]] ||
    fail "subscription $SUBSCRIPTION_NAME still exists; refusing to remove the temporary subscriber role"
  [[ "$remaining_publications" == '0' ]] ||
    fail "publication $PUBLICATION_NAME still exists; refusing to remove the temporary subscriber role"
  [[ "$remaining_slots" == '0' ]] ||
    fail "source slot $SLOT_NAME still exists; refusing to remove the temporary subscriber role"

  drop_target_subscriber_role
}

main() {
  local command="${1:-}"
  case "$command" in
    setup)
      setup_replication
      ;;
    status)
      status_replication
      ;;
    sync-sequences)
      sync_sequences
      ;;
    teardown)
      teardown_replication
      ;;
    -h | --help | help)
      usage
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
