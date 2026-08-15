#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PUBLICATION_NAME="${PUBLICATION_NAME:-boardsesh_migration}"
SUBSCRIPTION_NAME="${SUBSCRIPTION_NAME:-boardsesh_neon_sub}"
SLOT_NAME="${SLOT_NAME:-$SUBSCRIPTION_NAME}"
CHECK_TABLES="${CHECK_TABLES:-boardsesh_ticks board_user_syncs comments votes feed_items users}"
LOAD_SCHEMA="${LOAD_SCHEMA:-true}"
INCLUDE_SCHEMAS="${INCLUDE_SCHEMAS:-public drizzle}"
EXCLUDE_SCHEMAS="${EXCLUDE_SCHEMAS:-neon_auth neon_control_plane}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEON_DATABASE_URL="${NEON_DATABASE_URL:-${SOURCE_DATABASE_URL:-}}"
RAILWAY_DATABASE_URL="${RAILWAY_DATABASE_URL:-${TARGET_DATABASE_URL:-}}"
NEON_REPLICATION_DATABASE_URL="${NEON_REPLICATION_DATABASE_URL:-${SOURCE_REPLICATION_DATABASE_URL:-}}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/neon-to-railway-replication.sh setup
  scripts/neon-to-railway-replication.sh status
  scripts/neon-to-railway-replication.sh sync-sequences
  scripts/neon-to-railway-replication.sh teardown

Environment:
  NEON_DATABASE_URL                 Neon admin/source connection string.
  RAILWAY_DATABASE_URL              Railway direct Postgres connection string.
  NEON_REPLICATION_DATABASE_URL     Required for setup. Publisher conninfo for the
                                    subscription; must use a role with REPLICATION.
  SOURCE_DATABASE_URL               Generic alias for NEON_DATABASE_URL.
  TARGET_DATABASE_URL               Generic alias for RAILWAY_DATABASE_URL.
  SOURCE_REPLICATION_DATABASE_URL   Generic alias for NEON_REPLICATION_DATABASE_URL.
  TARGET_OWNER_ROLE                 Required for setup/status/sequence sync. Existing
                                    NOLOGIN, non-superuser role with database CREATE
                                    that owns restored app schemas and objects.
  TARGET_SUBSCRIBER_ROLE            Required for setup/status/sequence sync. Dedicated
                                    temporary LOGIN subscription owner with no app
                                    credential that can SET ROLE to TARGET_OWNER_ROLE;
                                    do not use the target admin.
  PUBLICATION_NAME                  Optional, default boardsesh_migration.
  SUBSCRIPTION_NAME                 Optional, default boardsesh_neon_sub.
  SLOT_NAME                         Optional, defaults to SUBSCRIPTION_NAME.
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
    Drops the Railway subscription and Neon publication after the guarded
    post-cutover acceptance window.
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
  psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
}

psql_railway() {
  psql "$RAILWAY_DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
}

psql_publisher() {
  psql "$NEON_REPLICATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"
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
  AND n.nspname NOT LIKE 'pg_toast%'
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
  require_env NEON_REPLICATION_DATABASE_URL

  local include_clause exclude_clause
  include_clause="$(schema_include_clause 'n.nspname')"
  exclude_clause="$(schema_exclude_clause 'n.nspname')"

  local source_database publisher_database publisher_contract publisher_row_security
  source_database="$(psql_neon -X -Atq -c 'SELECT current_database();')"
  publisher_database="$(psql_publisher -Atq -c 'SELECT current_database();')"
  [[ "$publisher_database" == "$source_database" ]] ||
    fail "publisher credential connects to database $publisher_database; expected $source_database"

  publisher_contract="$(psql_publisher -Atq -c "
SELECT rolcanlogin::text || '|' || rolsuper::text || '|' || rolreplication::text || '|' || rolbypassrls::text
FROM pg_roles
WHERE rolname = current_user;")"
  [[ "$publisher_contract" == 'true|false|true|false' ]] ||
    fail "publisher credential must be LOGIN, NOSUPERUSER, REPLICATION, and NOBYPASSRLS"

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
  AND NOT has_table_privilege(current_user, c.oid, 'SELECT')
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    WHERE d.classid = 'pg_class'::regclass
      AND d.objid = c.oid
      AND d.deptype = 'e'
  );")"
  [[ "$missing_select_privileges" == '0' ]] ||
    fail "publisher credential lacks SELECT on $missing_select_privileges published table(s)"

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

validate_target_subscriber_role() {
  require_env TARGET_OWNER_ROLE
  require_env TARGET_SUBSCRIBER_ROLE
  require_identifier TARGET_OWNER_ROLE "$TARGET_OWNER_ROLE"
  require_identifier TARGET_SUBSCRIBER_ROLE "$TARGET_SUBSCRIBER_ROLE"

  local subscriber_contract
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
       subscriber.rolreplication::text || '|' ||
       subscriber.rolbypassrls::text || '|' ||
       has_database_privilege(subscriber.oid, current_database(), 'CREATE')::text || '|' ||
       pg_has_role(subscriber.oid, create_subscription_role.oid, 'USAGE')::text || '|' ||
       EXISTS (
         SELECT 1 FROM pg_auth_members AS membership
         WHERE membership.member = subscriber.oid
           AND membership.roleid = owner_role.oid
           AND membership.set_option
           AND NOT membership.inherit_option
       )::text || '|' ||
       (current_user = '${TARGET_SUBSCRIBER_ROLE}' OR
        (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) OR
        pg_has_role(current_user, subscriber.oid, 'SET'))::text
FROM subscriber, owner_role, create_subscription_role;")"
  [[ "$subscriber_contract" == 'true|false|false|false|true|true|true|true' ]] ||
    fail "TARGET_SUBSCRIBER_ROLE must be a dedicated LOGIN/non-privileged role with database CREATE plus pg_create_subscription, SET ROLE to TARGET_OWNER_ROLE, and target-admin SET ROLE reachability"
}

grant_target_subscriber_schema_usage() {
  local include_clause
  include_clause="$(schema_include_clause 'nspname')"
  psql_railway <<SQL
SELECT format('GRANT USAGE ON SCHEMA %I TO %I;', nspname, '$TARGET_SUBSCRIBER_ROLE')
FROM pg_namespace
WHERE true
  ${include_clause}
ORDER BY nspname
\gexec
SQL
}

assert_subscription_contract() {
  validate_target_subscriber_role

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
  AND subscription.subpublications = ARRAY['${PUBLICATION_NAME}']::text[];")"
  [[ "$contract_matches" == 't' ]] ||
    fail "subscription $SUBSCRIPTION_NAME does not match the required owner/publication/slot/enabled/binary/origin/run_as_owner/password/failover contract"

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
  AND n.nspname NOT LIKE 'pg_toast%'
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
      AND n.nspname NOT LIKE 'pg_toast%'
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
  require_identifier PUBLICATION_NAME "$PUBLICATION_NAME"
  require_identifier SUBSCRIPTION_NAME "$SUBSCRIPTION_NAME"
  require_identifier SLOT_NAME "$SLOT_NAME"
}

setup_replication() {
  check_common_requirements
  require_env NEON_REPLICATION_DATABASE_URL
  require_env TARGET_OWNER_ROLE
  require_identifier TARGET_OWNER_ROLE "$TARGET_OWNER_ROLE"
  require_command pg_dump
  require_command pg_restore
  require_command awk

  local publisher_conninfo="$NEON_REPLICATION_DATABASE_URL"
  local wal_level
  wal_level="$(psql_neon -Atqc 'SHOW wal_level;')"
  [[ "$wal_level" == "logical" ]] || fail "Neon wal_level is '$wal_level'; enable logical replication first"

  validate_publisher_credential

  local target_owner_contract
  target_owner_contract="$(psql_railway -Atq -c "
SELECT count(*) = 1
FROM pg_roles
WHERE rolname = '${TARGET_OWNER_ROLE}'
  AND NOT rolcanlogin
  AND NOT rolsuper
  AND NOT rolreplication
  AND NOT rolbypassrls
  AND has_database_privilege(oid, current_database(), 'CREATE');")"
  [[ "$target_owner_contract" == "t" ]] ||
    fail "TARGET_OWNER_ROLE must be NOLOGIN/non-privileged and have CREATE on the target database"
  validate_target_subscriber_role

  echo "Creating required Railway extensions..."
  if ! psql_railway <<'SQL'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS hypopg;
SQL
  then
    fail "failed to create required extensions on Railway; use a Railway Postgres image/template that includes PostGIS"
  fi

  if [[ "$LOAD_SCHEMA" == "true" ]]; then
    local dump_file restore_list filtered_restore_list restore_stderr schema
    local -a schema_dump_args=()
    dump_file="$(mktemp "${TMPDIR:-/tmp}/boardsesh-schema.XXXXXX")"
    restore_list="$(mktemp "${TMPDIR:-/tmp}/boardsesh-schema-list.XXXXXX")"
    filtered_restore_list="$(mktemp "${TMPDIR:-/tmp}/boardsesh-schema-filtered.XXXXXX")"
    restore_stderr="$(mktemp "${TMPDIR:-/tmp}/boardsesh-schema-restore-stderr.XXXXXX")"
    trap 'rm -f "${dump_file:-}" "${restore_list:-}" "${filtered_restore_list:-}" "${restore_stderr:-}"' EXIT

    for schema in $INCLUDE_SCHEMAS; do
      require_identifier INCLUDE_SCHEMAS "$schema"
      schema_dump_args+=("--schema=$schema")
    done

    echo "Dumping Neon schema only..."
    pg_dump --schema-only --no-owner --no-acl --no-publications --no-subscriptions \
      "${schema_dump_args[@]}" --format=custom --file "$dump_file" "$NEON_DATABASE_URL"

    # Extensions are pre-created by the target admin. Application schemas are
    # also pre-created below because public already contains extension members.
    # Filter their CREATE SCHEMA entries, plus extension entries whose COMMENT
    # commands cannot run as the application owner.
    pg_restore --list "$dump_file" >"$restore_list"
    awk '$0 !~ / SCHEMA - / && $0 !~ / EXTENSION - / && $0 !~ / COMMENT - EXTENSION / { print }' \
      "$restore_list" >"$filtered_restore_list"

    for schema in $INCLUDE_SCHEMAS; do
      psql_railway -c "CREATE SCHEMA IF NOT EXISTS \"$schema\" AUTHORIZATION \"$TARGET_OWNER_ROLE\";"
      psql_railway -c "ALTER SCHEMA \"$schema\" OWNER TO \"$TARGET_OWNER_ROLE\";"
    done

    echo "Restoring schema to Railway..."
    if ! pg_restore --exit-on-error --schema-only --no-owner --no-acl \
      --role "$TARGET_OWNER_ROLE" --use-list "$filtered_restore_list" \
      --dbname "$RAILWAY_DATABASE_URL" "$dump_file" 2>"$restore_stderr"; then
      cat "$restore_stderr" >&2
      fail "schema restore failed; the target must be recreated or reconciled before retrying"
    fi
    if [[ -s "$restore_stderr" ]]; then
      cat "$restore_stderr" >&2
      fail "schema restore reported diagnostics; treat every restore warning as a failed migration gate"
    fi
    rm -f "$dump_file" "$restore_list" "$filtered_restore_list" "$restore_stderr"
    trap - EXIT
  else
    echo "Skipping schema load because LOAD_SCHEMA=false."
  fi

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

  local subscription_exists
  subscription_exists="$(psql_railway -Atq -c "SELECT 1 FROM pg_subscription WHERE subname = '$SUBSCRIPTION_NAME';")"
  if [[ "$subscription_exists" == "1" ]]; then
    assert_subscription_contract
    echo "Railway subscription '$SUBSCRIPTION_NAME' already exists and its exact catalog contract matches."
  else
    echo "Creating Railway subscription with copy_data=true..."
    psql_railway \
      -v publisher_conninfo="$publisher_conninfo" \
      -v subscriber_role="$TARGET_SUBSCRIBER_ROLE" <<SQL
SET ROLE :"subscriber_role";
CREATE SUBSCRIPTION $SUBSCRIPTION_NAME
  CONNECTION :'publisher_conninfo'
  PUBLICATION $PUBLICATION_NAME
  WITH (
    copy_data = true,
    create_slot = true,
    slot_name = '$SLOT_NAME',
    enabled = true,
    binary = false,
    origin = none,
    run_as_owner = false,
    password_required = true,
    failover = false
  );
RESET ROLE;
SQL
    assert_subscription_contract
  fi

  echo "Setup complete. Run '$0 status' until Railway is caught up."
}

status_replication() {
  check_common_requirements
  assert_subscription_contract

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
  assert_subscription_contract
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
  sql_file="$(mktemp "${TMPDIR:-/tmp}/boardsesh-sequences.XXXXXX")"
  target_sql_file="$(mktemp "${TMPDIR:-/tmp}/boardsesh-target-sequences.XXXXXX")"
  trap 'rm -f "${sql_file:-}" "${target_sql_file:-}"' EXIT

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
  trap - EXIT
  echo "Sequence sync complete."
}

teardown_replication() {
  [[ "${TEARDOWN_CONFIRMED:-false}" == "true" ]] ||
    fail "teardown requires TEARDOWN_CONFIRMED=true after the 72-hour acceptance window and a successful PG18 restore drill"
  check_common_requirements

  echo "Dropping Railway subscription if present..."
  local subscription_exists
  subscription_exists="$(psql_railway -Atq -c "SELECT 1 FROM pg_subscription WHERE subname = '$SUBSCRIPTION_NAME';")"
  if [[ "$subscription_exists" == "1" ]]; then
    psql_railway <<SQL
ALTER SUBSCRIPTION $SUBSCRIPTION_NAME DISABLE;
DROP SUBSCRIPTION $SUBSCRIPTION_NAME;
SQL
  else
    echo "Railway subscription '$SUBSCRIPTION_NAME' does not exist."
  fi

  echo "Dropping Neon publication if present..."
  psql_neon <<SQL
DROP PUBLICATION IF EXISTS $PUBLICATION_NAME;
SQL
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
