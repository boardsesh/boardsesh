#!/usr/bin/env bash
if [[ $- == *x* ]]; then
  set +x
fi
set -Eeuo pipefail
umask 077

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-}"
SOURCE_REPLICATION_DATABASE_URL="${SOURCE_REPLICATION_DATABASE_URL:-}"
TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-}"
EXPECTED_SOURCE_MAJOR="${EXPECTED_SOURCE_MAJOR:-16}"
EXPECTED_TARGET_MAJOR="${EXPECTED_TARGET_MAJOR:-18}"
EXPECTED_SOURCE_DATABASE="${EXPECTED_SOURCE_DATABASE:-railway}"
EXPECTED_TARGET_DATABASE="${EXPECTED_TARGET_DATABASE:-railway}"
EXPECTED_TARGET_VERSION_NUM="${EXPECTED_TARGET_VERSION_NUM:-180006}"
EXPECTED_POSTGIS_VERSION="${EXPECTED_POSTGIS_VERSION:-3.6.4}"
MIGRATION_SCHEMAS="${MIGRATION_SCHEMAS:-public drizzle}"
MIGRATION_EXCLUDED_SCHEMAS="${MIGRATION_EXCLUDED_SCHEMAS:-neon_auth neon_control_plane}"
MIGRATION_PUBLICATION_NAME="${MIGRATION_PUBLICATION_NAME:-boardsesh_pg18_migration}"
MIGRATION_SUBSCRIPTION_NAME="${MIGRATION_SUBSCRIPTION_NAME:-boardsesh_pg18_sub}"
MIGRATION_SLOT_NAME="${MIGRATION_SLOT_NAME:-boardsesh_pg18_migration}"
MIGRATION_OWNER_ROLE="${MIGRATION_OWNER_ROLE:-}"
MIGRATION_RUNTIME_ROLE="${MIGRATION_RUNTIME_ROLE:-}"
MIGRATION_MIGRATOR_ROLE="${MIGRATION_MIGRATOR_ROLE:-}"
MIGRATION_REPLICATION_ROLE="${MIGRATION_REPLICATION_ROLE:-}"
MIGRATION_SUBSCRIBER_ROLE="${MIGRATION_SUBSCRIBER_ROLE:-}"
MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE="${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE:-boardsesh_snapshot_fence_owner}"
MIGRATION_SNAPSHOT_COORDINATOR_ROLE="${MIGRATION_SNAPSHOT_COORDINATOR_ROLE:-}"
MIGRATION_REQUIRED_ROLES="${MIGRATION_REQUIRED_ROLES:-}"
MIGRATION_RUNTIME_SCHEMAS="${MIGRATION_RUNTIME_SCHEMAS:-}"
MATERIALIZED_VIEWS_REFRESH_PLANNED="${MATERIALIZED_VIEWS_REFRESH_PLANNED:-false}"
REQUIRE_PUBLICATION="${REQUIRE_PUBLICATION:-false}"
MIGRATION_AUDIT_CONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"
publisher_conninfo_digest=""
publisher_redacted_conninfo_digest=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/postgres-credentials.sh
source "$SCRIPT_DIR/lib/postgres-credentials.sh"

blocker_count=0

usage() {
  cat <<'USAGE'
Read-only PostgreSQL logical-migration preflight and catalog audit.

Required:
  SOURCE_DATABASE_URL              Direct PostgreSQL source URL (expected PG16).

Optional target comparison:
  TARGET_DATABASE_URL              Direct PostgreSQL target URL (expected PG18.6).
  MIGRATION_OWNER_ROLE             NOLOGIN, non-superuser owner of app objects.
  MIGRATION_RUNTIME_ROLE           LOGIN least-privilege application role.
  MIGRATION_MIGRATOR_ROLE          LOGIN migration role that can SET ROLE to owner.
  MIGRATION_REPLICATION_ROLE       LOGIN REPLICATION role used only by replication.
  MIGRATION_SUBSCRIBER_ROLE        Dedicated LOGIN owner of the temporary PG18 logical
                                    subscription. Required with target plus
                                    REQUIRE_PUBLICATION=true.
  MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE
                                    Dedicated NOLOGIN owner of the snapshot SECURITY
                                    DEFINER boundary (default boardsesh_snapshot_fence_owner).
  MIGRATION_SNAPSHOT_COORDINATOR_ROLE
                                    Optional narrow LOGIN caller. When set, the audit
                                    proves it cannot SET ROLE to the fence owner or
                                    create objects in the ops schema.
  MIGRATION_REQUIRED_ROLES         Optional additional role names to require.
                                    The owner, runtime, migrator, replication, and
                                    snapshot fence-owner roles are required when
                                    TARGET_DATABASE_URL is set.
  MIGRATION_RUNTIME_SCHEMAS        Required with a target. Exact included schemas the
                                    runtime role may access.

Optional controls:
  MIGRATION_SCHEMAS                Space-separated application schemas
                                    (default "public drizzle").
  MIGRATION_EXCLUDED_SCHEMAS       Explicit non-application schemas
                                    (default "neon_auth neon_control_plane").
  MIGRATION_PUBLICATION_NAME       Simple identifier (default boardsesh_pg18_migration).
  MIGRATION_SUBSCRIPTION_NAME      Simple identifier (default boardsesh_pg18_sub).
  MIGRATION_SLOT_NAME              Simple identifier (default boardsesh_pg18_migration).
  SOURCE_REPLICATION_DATABASE_URL  Dedicated publisher credential. Required when
                                    REQUIRE_PUBLICATION=true; must have LOGIN,
                                    REPLICATION, row_security=off, and SELECT on
                                    every published table.
  EXPECTED_SOURCE_MAJOR            Default 16.
  EXPECTED_TARGET_MAJOR            Default 18.
  EXPECTED_TARGET_VERSION_NUM      Default 180006 (PostgreSQL 18.6).
  EXPECTED_POSTGIS_VERSION         Default 3.6.4.
  MATERIALIZED_VIEWS_REFRESH_PLANNED
                                    Set true only when every reported materialized view
                                    has an explicit post-copy refresh/verification step.
  REQUIRE_PUBLICATION              Set true after setup to require exact publication
                                    coverage (default false during initial preflight).

The tool sets default_transaction_read_only=on and never prints connection URLs.
It exits non-zero for any unresolved migration blocker.
USAGE
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

blocker() {
  blocker_count=$((blocker_count + 1))
  printf 'BLOCKER: %s\n' "$*" >&2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found in PATH"
}

require_identifier() {
  local label="$1"
  local identifier="$2"
  [[ "$identifier" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    fail "$label must contain only simple PostgreSQL identifiers"
}

quoted_identifier_list() {
  local label="$1"
  local values="$2"
  local joined="" seen=' '
  local identifier
  for identifier in $values; do
    require_identifier "$label" "$identifier"
    [[ "$seen" != *" $identifier "* ]] || fail "$label contains duplicate schema $identifier"
    seen+="$identifier "
    if [[ -n "$joined" ]]; then
      joined+=", "
    fi
    joined+="'$identifier'"
  done
  [[ -n "$joined" ]] || fail "$label must contain at least one identifier"
  printf '%s' "$joined"
}

schema_values_list() {
  local label="$1" values="$2" joined='' identifier
  for identifier in $values; do
    require_identifier "$label" "$identifier"
    joined+="${joined:+, }('$identifier')"
  done
  [[ -n "$joined" ]] || fail "$label must contain at least one identifier"
  printf '%s' "$joined"
}

validate_schema_policy_lists() {
  local schema included_seen=' ' excluded_seen=' ' runtime_seen=' '
  for schema in $MIGRATION_SCHEMAS; do
    require_identifier MIGRATION_SCHEMAS "$schema"
    [[ "$included_seen" != *" $schema "* ]] ||
      fail "MIGRATION_SCHEMAS contains duplicate schema $schema"
    included_seen+="$schema "
  done
  [[ "$included_seen" != ' ' ]] || fail 'MIGRATION_SCHEMAS must contain at least one identifier'
  for schema in $MIGRATION_EXCLUDED_SCHEMAS; do
    require_identifier MIGRATION_EXCLUDED_SCHEMAS "$schema"
    [[ "$excluded_seen" != *" $schema "* ]] ||
      fail "MIGRATION_EXCLUDED_SCHEMAS contains duplicate schema $schema"
    [[ "$included_seen" != *" $schema "* ]] ||
      fail "schema $schema cannot appear in both MIGRATION_SCHEMAS and MIGRATION_EXCLUDED_SCHEMAS"
    excluded_seen+="$schema "
  done
  [[ "$excluded_seen" != ' ' ]] || fail 'MIGRATION_EXCLUDED_SCHEMAS must contain at least one identifier'
  if [[ -n "$TARGET_DATABASE_URL" ]]; then
    [[ -n "$MIGRATION_RUNTIME_SCHEMAS" ]] ||
      fail 'MIGRATION_RUNTIME_SCHEMAS is required when TARGET_DATABASE_URL is set'
    for schema in $MIGRATION_RUNTIME_SCHEMAS; do
      require_identifier MIGRATION_RUNTIME_SCHEMAS "$schema"
      [[ "$runtime_seen" != *" $schema "* ]] ||
        fail "MIGRATION_RUNTIME_SCHEMAS contains duplicate schema $schema"
      [[ "$included_seen" == *" $schema "* ]] ||
        fail "runtime schema $schema is not classified by MIGRATION_SCHEMAS"
      [[ "$excluded_seen" != *" $schema "* ]] ||
        fail "runtime schema $schema is excluded by MIGRATION_EXCLUDED_SCHEMAS"
      runtime_seen+="$schema "
    done
    [[ "$runtime_seen" != ' ' ]] || fail 'MIGRATION_RUNTIME_SCHEMAS must contain at least one identifier'
  fi
}

psql_readonly() {
  local connection_name="$1"
  shift
  BOARDSESH_LIBPQ_CONNECT_TIMEOUT="$MIGRATION_AUDIT_CONNECT_TIMEOUT" \
    BOARDSESH_LIBPQ_EXTRA_OPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000' \
    boardsesh_run_libpq_connection "$connection_name" \
      psql -X -v ON_ERROR_STOP=1 "$@"
}

psql_publisher_readonly() {
  BOARDSESH_LIBPQ_CONNECT_TIMEOUT="$MIGRATION_AUDIT_CONNECT_TIMEOUT" \
    BOARDSESH_LIBPQ_EXTRA_OPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000' \
    boardsesh_run_libpq_connection PUBLISHER \
      psql -X -v ON_ERROR_STOP=1 "$@"
}

scalar() {
  local connection_url="$1"
  local sql="$2"
  psql_readonly "$connection_url" -Atq -c "$sql"
}

publisher_scalar() {
  local sql="$1"
  psql_publisher_readonly -Atq -c "$sql"
}

report_query() {
  local heading="$1"
  local connection_url="$2"
  local sql="$3"
  printf '\n## %s\n' "$heading"
  psql_readonly "$connection_url" --pset=pager=off --pset=null='NULL' -c "$sql"
}

catalog_tables() {
  local connection_url="$1"
  psql_readonly "$connection_url" -Atq -c "
SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND relation.relpersistence = 'p'
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY 1;"
}

column_acl_count() {
  local connection_name="$1"
  scalar "$connection_name" "
SELECT count(*)
FROM pg_catalog.pg_attribute AS attribute
JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND attribute.attacl IS NOT NULL
  AND relation.relkind IN ('r', 'p', 'v', 'm')
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  );"
}

replication_tables() {
  local connection_url="$1"
  psql_readonly "$connection_url" -Atq -c "
SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind = 'r'
  AND relation.relpersistence = 'p'
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY 1;"
}

sequence_ownership() {
  local connection_url="$1"
  psql_readonly "$connection_url" -Atq -F $'\t' -c "
SELECT pg_catalog.format('%I.%I', sequence_namespace.nspname, sequence_class.relname),
       pg_catalog.format('%I.%I', owner_namespace.nspname, owner_class.relname),
       owner_attribute.attname,
       ownership.deptype
FROM pg_catalog.pg_class AS sequence_class
JOIN pg_catalog.pg_namespace AS sequence_namespace
  ON sequence_namespace.oid = sequence_class.relnamespace
JOIN pg_catalog.pg_depend AS ownership
  ON ownership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
 AND ownership.objid = sequence_class.oid
 AND ownership.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
 AND ownership.deptype IN ('a', 'i')
 AND ownership.refobjsubid > 0
JOIN pg_catalog.pg_class AS owner_class ON owner_class.oid = ownership.refobjid
JOIN pg_catalog.pg_namespace AS owner_namespace ON owner_namespace.oid = owner_class.relnamespace
JOIN pg_catalog.pg_attribute AS owner_attribute
  ON owner_attribute.attrelid = owner_class.oid
 AND owner_attribute.attnum = ownership.refobjsubid
 AND NOT owner_attribute.attisdropped
WHERE sequence_class.relkind = 'S'
  AND sequence_class.relpersistence = 'p'
  AND sequence_namespace.nspname IN (${included_schemas_sql})
  AND sequence_namespace.nspname NOT IN (${excluded_schemas_sql})
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid IN (sequence_class.oid, owner_class.oid)
      AND extension_dependency.deptype = 'e'
  )
ORDER BY 1;"
}

extension_manifest() {
  local connection_url="$1"
  psql_readonly "$connection_url" -Atq -c "
SELECT extension.extname
       || '|' || extension.extversion
       || '|' || namespace.nspname
       || '|' || extension.extrelocatable::text
FROM pg_catalog.pg_extension AS extension
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
WHERE extension.extname <> 'plpgsql'
ORDER BY extension.extname;"
}

unclassified_schemas() {
  local connection_url="$1"
  scalar "$connection_url" "
SELECT coalesce(pg_catalog.string_agg(namespace.nspname, ', ' ORDER BY namespace.nspname), '')
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname NOT IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND namespace.nspname !~ '^pg_toast'
  AND namespace.nspname !~ '^pg_temp_';"
}

schema_catalog() {
  local connection_url="$1"
  local output_mode="$2"
  [[ "$output_mode" == 'manifest' || "$output_mode" == 'fingerprint' ]] ||
    fail "invalid schema catalog output mode"
  psql_readonly "$connection_url" -Atq -c "
WITH fingerprint_rows AS (
  SELECT 'schema'::text AS category,
         pg_catalog.quote_ident(namespace.nspname) AS identity,
         pg_catalog.pg_get_userbyid(namespace.nspowner) AS definition
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})

  UNION ALL

  SELECT 'relation'::text AS category,
         pg_catalog.format('%I.%I', namespace.nspname, relation.relname) AS identity,
         pg_catalog.concat_ws('|', relation.relkind, relation.relpersistence,
           relation.relreplident, relation.relrowsecurity::text,
           relation.relforcerowsecurity::text,
           coalesce(pg_catalog.pg_get_partkeydef(relation.oid), ''),
           coalesce(pg_catalog.pg_get_expr(relation.relpartbound, relation.oid), ''),
           coalesce(pg_catalog.array_to_string(relation.reloptions, ','), ''),
           coalesce(access_method.amname, '')) AS definition
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_am AS access_method ON access_method.oid = relation.relam
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'c')
    AND namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND extension_dependency.objid = relation.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'view',
         pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
         pg_catalog.pg_get_viewdef(relation.oid, false)
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.relkind IN ('v', 'm')
    AND namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND extension_dependency.objid = relation.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'sequence',
         pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
         pg_catalog.concat_ws('|', pg_catalog.format_type(sequence.seqtypid, NULL),
           sequence.seqstart::text, sequence.seqincrement::text,
           sequence.seqmin::text, sequence.seqmax::text,
           sequence.seqcache::text, sequence.seqcycle::text)
  FROM pg_catalog.pg_sequence AS sequence
  JOIN pg_catalog.pg_class AS relation ON relation.oid = sequence.seqrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND extension_dependency.objid = relation.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'column'::text AS category,
         pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, attribute.attname) AS identity,
         pg_catalog.concat_ws('|',
           attribute.attnum::text,
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
           attribute.attnotnull::text,
           attribute.attidentity::text,
           attribute.attgenerated::text,
           attribute.attstorage::text,
           attribute.attcompression::text,
           attribute.attstattarget::text,
           coalesce(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid), ''),
           coalesce(collation_row.collname, '')
         ) AS definition
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef AS default_value
    ON default_value.adrelid = relation.oid AND default_value.adnum = attribute.attnum
  LEFT JOIN pg_catalog.pg_collation AS collation_row
    ON collation_row.oid = attribute.attcollation
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'c')
    AND namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND extension_dependency.objid = relation.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'constraint',
         pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, constraint_row.conname),
         pg_catalog.concat_ws('|', constraint_row.contype, constraint_row.convalidated::text,
           constraint_row.condeferrable::text, constraint_row.condeferred::text,
           pg_catalog.pg_get_constraintdef(constraint_row.oid, false))
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})

  UNION ALL

  SELECT 'domain_constraint',
         pg_catalog.format('%I.%I.%I', namespace.nspname, type.typname, constraint_row.conname),
         pg_catalog.concat_ws('|', constraint_row.contype, constraint_row.convalidated::text,
           constraint_row.condeferrable::text, constraint_row.condeferred::text,
           pg_catalog.pg_get_constraintdef(constraint_row.oid, false))
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_type AS type ON type.oid = constraint_row.contypid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type.typnamespace
  WHERE constraint_row.contypid <> 0
    AND namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
        AND extension_dependency.objid = type.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'index',
         pg_catalog.format('%I.%I', index_namespace.nspname, index_class.relname),
         pg_catalog.concat_ws('|', index_row.indisunique::text, index_row.indisprimary::text,
           index_row.indisvalid::text, index_row.indisreplident::text,
           index_row.indisclustered::text, pg_catalog.pg_get_indexdef(index_row.indexrelid))
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS index_class ON index_class.oid = index_row.indexrelid
  JOIN pg_catalog.pg_class AS table_class ON table_class.oid = index_row.indrelid
  JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
  WHERE index_namespace.nspname IN (${included_schemas_sql})
    AND index_namespace.nspname NOT IN (${excluded_schemas_sql})

  UNION ALL

  SELECT 'inheritance',
         pg_catalog.format('%I.%I/%s', child_namespace.nspname, child.relname,
           inheritance.inhseqno),
         pg_catalog.format('%I.%I', parent_namespace.nspname, parent.relname)
  FROM pg_catalog.pg_inherits AS inheritance
  JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
  JOIN pg_catalog.pg_namespace AS child_namespace ON child_namespace.oid = child.relnamespace
  JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
  JOIN pg_catalog.pg_namespace AS parent_namespace ON parent_namespace.oid = parent.relnamespace
  WHERE child_namespace.nspname IN (${included_schemas_sql})
    AND child_namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND extension_dependency.objid = child.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'function',
         pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
           pg_catalog.pg_get_function_identity_arguments(procedure.oid)),
         pg_catalog.concat_ws('|', language.lanname, procedure.prokind, procedure.provolatile,
           procedure.proisstrict::text, procedure.prosecdef::text,
           procedure.proleakproof::text, procedure.proparallel,
           procedure.procost::text, procedure.prorows::text,
           procedure.pronargdefaults::text,
           coalesce(pg_catalog.pg_get_expr(procedure.proargdefaults, 0), ''),
           pg_catalog.pg_get_function_result(procedure.oid), procedure.prosrc,
           coalesce(procedure.probin, ''),
           coalesce(pg_catalog.array_to_string(procedure.proconfig, ','), ''))
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND extension_dependency.objid = procedure.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'trigger',
         pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, trigger.tgname),
         pg_catalog.pg_get_triggerdef(trigger.oid, false)
  FROM pg_catalog.pg_trigger AS trigger
  JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT trigger.tgisinternal

  UNION ALL

  SELECT 'policy',
         pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, policy.polname),
         pg_catalog.concat_ws('|', policy.polcmd, policy.polpermissive::text,
           coalesce(policy_roles.role_names, ''),
           coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), ''),
           coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), ''))
  FROM pg_catalog.pg_policy AS policy
  JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  LEFT JOIN LATERAL (
    SELECT pg_catalog.string_agg(
             CASE role_oid WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid) END,
             ',' ORDER BY
             CASE role_oid WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid) END
           ) AS role_names
    FROM pg_catalog.unnest(policy.polroles) AS role_oid
  ) AS policy_roles ON true
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})

  UNION ALL

  SELECT 'type',
         pg_catalog.format('%I.%I', namespace.nspname, type.typname),
         pg_catalog.concat_ws('|',
           type.typtype,
           pg_catalog.format_type(type.typbasetype, type.typtypmod),
           type.typnotnull::text,
           coalesce(pg_catalog.pg_get_expr(type.typdefaultbin, 0), type.typdefault, ''),
           CASE WHEN type_collation.oid IS NULL THEN ''
             ELSE pg_catalog.format('%I.%I', collation_namespace.nspname, type_collation.collname)
           END,
           coalesce(enum_values.enum_labels, ''),
           coalesce(range_definition.definition, '')
         )
  FROM pg_catalog.pg_type AS type
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type.typnamespace
  LEFT JOIN pg_catalog.pg_collation AS type_collation ON type_collation.oid = type.typcollation
  LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
    ON collation_namespace.oid = type_collation.collnamespace
  LEFT JOIN LATERAL (
    SELECT pg_catalog.json_agg(enum.enumlabel ORDER BY enum.enumsortorder)::text AS enum_labels
    FROM pg_catalog.pg_enum AS enum
    WHERE enum.enumtypid = type.oid
  ) AS enum_values ON true
  LEFT JOIN LATERAL (
    SELECT pg_catalog.concat_ws('|',
             pg_catalog.format_type(range_row.rngsubtype, NULL),
             CASE WHEN range_collation.oid IS NULL THEN ''
               ELSE pg_catalog.format('%I.%I', range_collation_namespace.nspname,
                                      range_collation.collname)
             END,
             pg_catalog.format('%I.%I', operator_namespace.nspname, operator_class.opcname),
             range_row.rngcanonical::pg_catalog.regprocedure::text,
             range_row.rngsubdiff::pg_catalog.regprocedure::text,
             pg_catalog.format_type(range_row.rngtypid, NULL),
             pg_catalog.format_type(range_row.rngmultitypid, NULL)
           ) AS definition
    FROM pg_catalog.pg_range AS range_row
    JOIN pg_catalog.pg_opclass AS operator_class ON operator_class.oid = range_row.rngsubopc
    JOIN pg_catalog.pg_namespace AS operator_namespace
      ON operator_namespace.oid = operator_class.opcnamespace
    LEFT JOIN pg_catalog.pg_collation AS range_collation
      ON range_collation.oid = range_row.rngcollation
    LEFT JOIN pg_catalog.pg_namespace AS range_collation_namespace
      ON range_collation_namespace.oid = range_collation.collnamespace
    WHERE range_row.rngtypid = type.oid OR range_row.rngmultitypid = type.oid
  ) AS range_definition ON true
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND (
      type.typrelid = 0
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS composite_relation
        WHERE composite_relation.oid = type.typrelid
          AND composite_relation.relkind = 'c'
      )
    )
    AND type.typtype IN ('c', 'd', 'e', 'm', 'r')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
        AND extension_dependency.objid = type.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'collation',
         pg_catalog.format('%I.%I', namespace.nspname, collation_row.collname),
         pg_catalog.concat_ws('|', collation_row.collencoding::text, collation_row.collprovider,
           collation_row.collisdeterministic::text, collation_row.collcollate, collation_row.collctype,
           coalesce(pg_catalog.to_jsonb(collation_row)->>'colllocale',
                    pg_catalog.to_jsonb(collation_row)->>'colliculocale', ''),
           coalesce(pg_catalog.to_jsonb(collation_row)->>'collicurules', ''),
           coalesce(collation_row.collversion, ''))
  FROM pg_catalog.pg_collation AS collation_row
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = collation_row.collnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_collation'::pg_catalog.regclass
        AND extension_dependency.objid = collation_row.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'operator',
         pg_catalog.format('%I.%I(%s,%s)', namespace.nspname, operator.oprname,
           CASE operator.oprleft WHEN 0 THEN 'NONE'
             ELSE pg_catalog.format_type(operator.oprleft, NULL) END,
           CASE operator.oprright WHEN 0 THEN 'NONE'
             ELSE pg_catalog.format_type(operator.oprright, NULL) END),
         pg_catalog.concat_ws('|', operator.oprkind, operator.oprcanmerge::text,
           operator.oprcanhash::text, pg_catalog.format_type(operator.oprresult, NULL),
           operator.oprcode::pg_catalog.regprocedure::text,
           operator.oprcom::pg_catalog.regoperator::text,
           operator.oprnegate::pg_catalog.regoperator::text,
           operator.oprrest::pg_catalog.regprocedure::text,
           operator.oprjoin::pg_catalog.regprocedure::text)
  FROM pg_catalog.pg_operator AS operator
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = operator.oprnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_operator'::pg_catalog.regclass
        AND extension_dependency.objid = operator.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'operator_family',
         pg_catalog.format('%I.%I/%I', namespace.nspname, family.opfname, access_method.amname),
         ''
  FROM pg_catalog.pg_opfamily AS family
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = family.opfnamespace
  JOIN pg_catalog.pg_am AS access_method ON access_method.oid = family.opfmethod
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_opfamily'::pg_catalog.regclass
        AND extension_dependency.objid = family.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'operator_class',
         pg_catalog.format('%I.%I/%I', namespace.nspname, operator_class.opcname,
           access_method.amname),
         pg_catalog.concat_ws('|', operator_class.opcdefault::text,
           pg_catalog.format_type(operator_class.opcintype, NULL),
           pg_catalog.format_type(operator_class.opckeytype, NULL),
           pg_catalog.format('%I.%I', family_namespace.nspname, family.opfname))
  FROM pg_catalog.pg_opclass AS operator_class
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = operator_class.opcnamespace
  JOIN pg_catalog.pg_am AS access_method ON access_method.oid = operator_class.opcmethod
  JOIN pg_catalog.pg_opfamily AS family ON family.oid = operator_class.opcfamily
  JOIN pg_catalog.pg_namespace AS family_namespace ON family_namespace.oid = family.opfnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_opclass'::pg_catalog.regclass
        AND extension_dependency.objid = operator_class.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'operator_family_operator',
         pg_catalog.format('%I.%I/%I/%s/%s/%s', namespace.nspname, family.opfname,
           access_method.amname, family_operator.amopstrategy,
           pg_catalog.format_type(family_operator.amoplefttype, NULL),
           pg_catalog.format_type(family_operator.amoprighttype, NULL)),
         pg_catalog.concat_ws('|', family_operator.amoppurpose,
           family_operator.amopopr::pg_catalog.regoperator::text,
           coalesce(sort_namespace.nspname || '.' || sort_family.opfname, ''))
  FROM pg_catalog.pg_amop AS family_operator
  JOIN pg_catalog.pg_opfamily AS family ON family.oid = family_operator.amopfamily
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = family.opfnamespace
  JOIN pg_catalog.pg_am AS access_method ON access_method.oid = family.opfmethod
  LEFT JOIN pg_catalog.pg_opfamily AS sort_family ON sort_family.oid = family_operator.amopsortfamily
  LEFT JOIN pg_catalog.pg_namespace AS sort_namespace ON sort_namespace.oid = sort_family.opfnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})

  UNION ALL

  SELECT 'operator_family_function',
         pg_catalog.format('%I.%I/%I/%s/%s/%s', namespace.nspname, family.opfname,
           access_method.amname, family_function.amprocnum,
           pg_catalog.format_type(family_function.amproclefttype, NULL),
           pg_catalog.format_type(family_function.amprocrighttype, NULL)),
         family_function.amproc::pg_catalog.regprocedure::text
  FROM pg_catalog.pg_amproc AS family_function
  JOIN pg_catalog.pg_opfamily AS family ON family.oid = family_function.amprocfamily
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = family.opfnamespace
  JOIN pg_catalog.pg_am AS access_method ON access_method.oid = family.opfmethod
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})

  UNION ALL

  SELECT 'cast',
         pg_catalog.format('%s AS %s', pg_catalog.format_type(cast_row.castsource, NULL),
           pg_catalog.format_type(cast_row.casttarget, NULL)),
         pg_catalog.concat_ws('|', cast_row.castcontext, cast_row.castmethod,
           cast_row.castfunc::pg_catalog.regprocedure::text)
  FROM pg_catalog.pg_cast AS cast_row
  JOIN pg_catalog.pg_type AS source_type ON source_type.oid = cast_row.castsource
  JOIN pg_catalog.pg_namespace AS source_namespace ON source_namespace.oid = source_type.typnamespace
  JOIN pg_catalog.pg_type AS target_type ON target_type.oid = cast_row.casttarget
  JOIN pg_catalog.pg_namespace AS target_namespace ON target_namespace.oid = target_type.typnamespace
  LEFT JOIN pg_catalog.pg_proc AS cast_function ON cast_function.oid = cast_row.castfunc
  LEFT JOIN pg_catalog.pg_namespace AS function_namespace
    ON function_namespace.oid = cast_function.pronamespace
  WHERE (
      source_namespace.nspname IN (${included_schemas_sql})
      OR target_namespace.nspname IN (${included_schemas_sql})
      OR function_namespace.nspname IN (${included_schemas_sql})
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_cast'::pg_catalog.regclass
        AND extension_dependency.objid = cast_row.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'extended_statistics',
         pg_catalog.format('%I.%I', namespace.nspname, statistics.stxname),
         pg_catalog.concat_ws('|', statistics.stxrelid::pg_catalog.regclass::text,
           statistics.stxkeys::text, statistics.stxkind::text,
           statistics.stxstattarget::text,
           coalesce(pg_catalog.pg_get_expr(statistics.stxexprs, statistics.stxrelid), ''))
  FROM pg_catalog.pg_statistic_ext AS statistics
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = statistics.stxnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_statistic_ext'::pg_catalog.regclass
        AND extension_dependency.objid = statistics.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'rule',
         pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, rule.rulename),
         pg_catalog.pg_get_ruledef(rule.oid, false)
  FROM pg_catalog.pg_rewrite AS rule
  JOIN pg_catalog.pg_class AS relation ON relation.oid = rule.ev_class
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND rule.rulename <> '_RETURN'

  UNION ALL

  SELECT 'default_acl',
         pg_catalog.format('%s/%s/%s/%s', pg_catalog.pg_get_userbyid(default_acl.defaclrole),
           coalesce(namespace.nspname, 'ALL_SCHEMAS'), default_acl.defaclobjtype,
           CASE privilege.grantee WHEN 0 THEN 'PUBLIC'
             ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END),
         privilege.privilege_type || '|' || privilege.is_grantable::text
  FROM pg_catalog.pg_default_acl AS default_acl
  LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
  WHERE namespace.nspname IN (${included_schemas_sql})
     OR (
       namespace.oid IS NULL
       AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_namespace AS owned_namespace
         WHERE owned_namespace.nspname IN (${included_schemas_sql})
           AND owned_namespace.nspowner = default_acl.defaclrole
       )
     )
)
SELECT pg_catalog.json_build_array(category, identity, definition)::text
FROM fingerprint_rows
WHERE '${output_mode}' = 'manifest'
UNION ALL
SELECT pg_catalog.md5(pg_catalog.string_agg(category || E'\\x1f' || identity || E'\\x1f' || definition,
                                           E'\\x1e' ORDER BY category, identity))
FROM fingerprint_rows
HAVING '${output_mode}' = 'fingerprint'
ORDER BY 1;"
}

unsupported_ddl_manifest() {
  local connection_url="$1"
  psql_readonly "$connection_url" -Atq -c "
WITH unsupported(category, identity) AS (
  SELECT 'aggregate',
         pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
           pg_catalog.pg_get_function_identity_arguments(procedure.oid))
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE procedure.prokind = 'a'
    AND namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND extension_dependency.objid = procedure.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'base_or_pseudo_type',
         pg_catalog.format('%I.%I', namespace.nspname, type_row.typname)
  FROM pg_catalog.pg_type AS type_row
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
  WHERE type_row.typtype IN ('b', 'p')
    AND type_row.typelem = 0
    AND namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
        AND extension_dependency.objid = type_row.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'conversion', pg_catalog.format('%I.%I', namespace.nspname, conversion.conname)
  FROM pg_catalog.pg_conversion AS conversion
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = conversion.connamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_conversion'::pg_catalog.regclass
        AND extension_dependency.objid = conversion.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'text_search_configuration',
         pg_catalog.format('%I.%I', namespace.nspname, configuration.cfgname)
  FROM pg_catalog.pg_ts_config AS configuration
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = configuration.cfgnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_ts_config'::pg_catalog.regclass
        AND extension_dependency.objid = configuration.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'text_search_dictionary',
         pg_catalog.format('%I.%I', namespace.nspname, dictionary.dictname)
  FROM pg_catalog.pg_ts_dict AS dictionary
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = dictionary.dictnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_ts_dict'::pg_catalog.regclass
        AND extension_dependency.objid = dictionary.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'text_search_parser', pg_catalog.format('%I.%I', namespace.nspname, parser.prsname)
  FROM pg_catalog.pg_ts_parser AS parser
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = parser.prsnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_ts_parser'::pg_catalog.regclass
        AND extension_dependency.objid = parser.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'text_search_template', pg_catalog.format('%I.%I', namespace.nspname, template.tmplname)
  FROM pg_catalog.pg_ts_template AS template
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = template.tmplnamespace
  WHERE namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_ts_template'::pg_catalog.regclass
        AND extension_dependency.objid = template.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'event_trigger', event_trigger.evtname
  FROM pg_catalog.pg_event_trigger AS event_trigger

  UNION ALL

  SELECT 'foreign_data_wrapper', wrapper.fdwname
  FROM pg_catalog.pg_foreign_data_wrapper AS wrapper
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_foreign_data_wrapper'::pg_catalog.regclass
      AND extension_dependency.objid = wrapper.oid
      AND extension_dependency.deptype = 'e'
  )

  UNION ALL

  SELECT 'foreign_server', server.srvname
  FROM pg_catalog.pg_foreign_server AS server
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_foreign_server'::pg_catalog.regclass
      AND extension_dependency.objid = server.oid
      AND extension_dependency.deptype = 'e'
  )

  UNION ALL

  SELECT 'user_mapping',
         pg_catalog.format('%s/%s',
           CASE mapping.umuser WHEN 0 THEN 'PUBLIC'
             ELSE pg_catalog.pg_get_userbyid(mapping.umuser) END,
           server.srvname)
  FROM pg_catalog.pg_user_mapping AS mapping
  JOIN pg_catalog.pg_foreign_server AS server ON server.oid = mapping.umserver

  UNION ALL

  SELECT 'access_method', access_method.amname
  FROM pg_catalog.pg_am AS access_method
  WHERE access_method.oid >= 16384
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_am'::pg_catalog.regclass
        AND extension_dependency.objid = access_method.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'procedural_language', language.lanname
  FROM pg_catalog.pg_language AS language
  WHERE language.oid >= 16384
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_language'::pg_catalog.regclass
        AND extension_dependency.objid = language.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'transform',
         pg_catalog.format('%s/%s', pg_catalog.format_type(transform.trftype, NULL), language.lanname)
  FROM pg_catalog.pg_transform AS transform
  JOIN pg_catalog.pg_type AS transformed_type ON transformed_type.oid = transform.trftype
  JOIN pg_catalog.pg_namespace AS type_namespace ON type_namespace.oid = transformed_type.typnamespace
  JOIN pg_catalog.pg_language AS language ON language.oid = transform.trflang
  LEFT JOIN pg_catalog.pg_proc AS from_sql ON from_sql.oid = transform.trffromsql
  LEFT JOIN pg_catalog.pg_namespace AS from_namespace ON from_namespace.oid = from_sql.pronamespace
  LEFT JOIN pg_catalog.pg_proc AS to_sql ON to_sql.oid = transform.trftosql
  LEFT JOIN pg_catalog.pg_namespace AS to_namespace ON to_namespace.oid = to_sql.pronamespace
  WHERE (
      type_namespace.nspname IN (${included_schemas_sql})
      OR from_namespace.nspname IN (${included_schemas_sql})
      OR to_namespace.nspname IN (${included_schemas_sql})
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_transform'::pg_catalog.regclass
        AND extension_dependency.objid = transform.oid
        AND extension_dependency.deptype = 'e'
    )
)
SELECT category || ':' || identity
FROM unsupported
ORDER BY category, identity;"
}

runtime_acl_manifest() {
  local connection_url="$1"
  local runtime_role="$2"
  psql_readonly "$connection_url" -Atq -c "
WITH selected_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${runtime_role}'
), acl_rows AS (
  SELECT 'schema'::text AS category,
         pg_catalog.quote_ident(namespace.nspname) AS identity,
         (CASE privilege.grantee WHEN 0 THEN 'PUBLIC' ELSE '${runtime_role}' END) || '|' ||
           privilege.privilege_type || '|' || privilege.is_grantable::text AS definition
  FROM pg_catalog.pg_namespace AS namespace
  CROSS JOIN selected_role
  CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
  WHERE namespace.nspname IN (${runtime_schemas_sql})
    AND privilege.grantee IN (0, selected_role.oid)

  UNION ALL

  SELECT 'relation', pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
         (CASE privilege.grantee WHEN 0 THEN 'PUBLIC' ELSE '${runtime_role}' END) || '|' ||
           privilege.privilege_type || '|' || privilege.is_grantable::text
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  CROSS JOIN selected_role
  CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S')
    AND namespace.nspname IN (${runtime_schemas_sql})
    AND privilege.grantee IN (0, selected_role.oid)
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND extension_dependency.objid = relation.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'function',
         pg_catalog.format('%I.%I(%s)', namespace.nspname, procedure.proname,
           pg_catalog.pg_get_function_identity_arguments(procedure.oid)),
         (CASE privilege.grantee WHEN 0 THEN 'PUBLIC' ELSE '${runtime_role}' END) || '|' ||
           privilege.privilege_type || '|' || privilege.is_grantable::text
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  CROSS JOIN selected_role
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege
  WHERE namespace.nspname IN (${runtime_schemas_sql})
    AND privilege.grantee IN (0, selected_role.oid)
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND extension_dependency.objid = procedure.oid
        AND extension_dependency.deptype = 'e'
    )

  UNION ALL

  SELECT 'type', pg_catalog.format('%I.%I', namespace.nspname, type_row.typname),
         (CASE privilege.grantee WHEN 0 THEN 'PUBLIC' ELSE '${runtime_role}' END) || '|' ||
           privilege.privilege_type || '|' || privilege.is_grantable::text
  FROM pg_catalog.pg_type AS type_row
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
  CROSS JOIN selected_role
  CROSS JOIN LATERAL pg_catalog.aclexplode(type_row.typacl) AS privilege
  WHERE namespace.nspname IN (${runtime_schemas_sql})
    AND (
      type_row.typrelid = 0
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS composite_relation
        WHERE composite_relation.oid = type_row.typrelid
          AND composite_relation.relkind = 'c'
      )
    )
    -- Multiranges inherit their range ACL and reject GRANT/REVOKE directly.
    AND type_row.typtype IN ('c', 'd', 'e', 'r')
    AND privilege.grantee IN (0, selected_role.oid)
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
        AND extension_dependency.objid = type_row.oid
        AND extension_dependency.deptype = 'e'
    )
)
SELECT pg_catalog.json_build_array(category, identity, definition)::text
FROM acl_rows
ORDER BY category, identity, definition;"
}

compare_manifests() {
  local label="$1"
  local source_file="$2"
  local target_file="$3"
  if ! cmp -s "$source_file" "$target_file"; then
    blocker "$label differs between source and target"
    diff -u "$source_file" "$target_file" || true
  fi
}

if [[ "${1:-}" == '-h' || "${1:-}" == '--help' || "${1:-}" == 'help' ]]; then
  usage
  exit 0
fi
[[ $# -eq 0 ]] || fail "unexpected arguments; use --help"

require_command psql
require_command cmp
require_command comm
require_command diff
[[ -n "$SOURCE_DATABASE_URL" ]] || fail "SOURCE_DATABASE_URL is required"
[[ "$EXPECTED_SOURCE_MAJOR" =~ ^[0-9]+$ ]] || fail "EXPECTED_SOURCE_MAJOR must be numeric"
[[ "$EXPECTED_TARGET_MAJOR" =~ ^[0-9]+$ ]] || fail "EXPECTED_TARGET_MAJOR must be numeric"
[[ "$EXPECTED_TARGET_VERSION_NUM" =~ ^[0-9]+$ ]] || fail "EXPECTED_TARGET_VERSION_NUM must be numeric"
require_identifier MIGRATION_PUBLICATION_NAME "$MIGRATION_PUBLICATION_NAME"
require_identifier MIGRATION_SUBSCRIPTION_NAME "$MIGRATION_SUBSCRIPTION_NAME"
require_identifier MIGRATION_SLOT_NAME "$MIGRATION_SLOT_NAME"
require_identifier MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE "$MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE"
if [[ -n "$MIGRATION_SNAPSHOT_COORDINATOR_ROLE" ]]; then
  require_identifier MIGRATION_SNAPSHOT_COORDINATOR_ROLE "$MIGRATION_SNAPSHOT_COORDINATOR_ROLE"
fi

validate_schema_policy_lists
included_schemas_sql="$(quoted_identifier_list MIGRATION_SCHEMAS "$MIGRATION_SCHEMAS")"
excluded_schemas_sql="$(quoted_identifier_list MIGRATION_EXCLUDED_SCHEMAS "$MIGRATION_EXCLUDED_SCHEMAS")"
included_schema_values_sql="$(schema_values_list MIGRATION_SCHEMAS "$MIGRATION_SCHEMAS")"
if [[ -n "$TARGET_DATABASE_URL" ]]; then
  runtime_schemas_sql="$(quoted_identifier_list MIGRATION_RUNTIME_SCHEMAS "$MIGRATION_RUNTIME_SCHEMAS")"
  runtime_schema_values_sql="$(schema_values_list MIGRATION_RUNTIME_SCHEMAS "$MIGRATION_RUNTIME_SCHEMAS")"
else
  runtime_schemas_sql="'__source_only_audit__'"
  runtime_schema_values_sql="('__source_only_audit__')"
fi

audit_directory="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-pg-migration-audit.XXXXXX")"
trap 'rm -rf "$audit_directory"' EXIT
credential_directory="$audit_directory/credentials"
mkdir -m 0700 "$credential_directory"
boardsesh_prepare_libpq_connection SOURCE "$SOURCE_DATABASE_URL" "$credential_directory"
SOURCE_DATABASE_URL=SOURCE
if [[ -n "$TARGET_DATABASE_URL" ]]; then
  boardsesh_prepare_libpq_connection TARGET "$TARGET_DATABASE_URL" "$credential_directory"
  TARGET_DATABASE_URL=TARGET
fi
if [[ -n "$SOURCE_REPLICATION_DATABASE_URL" ]]; then
  boardsesh_prepare_libpq_connection PUBLISHER "$SOURCE_REPLICATION_DATABASE_URL" "$credential_directory"
  if [[ " ${BOARDSESH_LIBPQ_PUBLISHER_ENV_NAMES:-} " == *' PGAPPNAME '* ]]; then
    [[ "${BOARDSESH_LIBPQ_PUBLISHER_PGAPPNAME}" == "$MIGRATION_SUBSCRIPTION_NAME" ]] ||
      fail "publisher application_name must equal the canonical subscription name $MIGRATION_SUBSCRIPTION_NAME"
  else
    boardsesh_store_libpq_env PUBLISHER PGAPPNAME "$MIGRATION_SUBSCRIPTION_NAME"
  fi
  if [[ -z "${BOARDSESH_LIBPQ_PUBLISHER_PASSWORD:-}" ]]; then
    fail "SOURCE_REPLICATION_DATABASE_URL must contain a password for password_required=true"
  fi
  publisher_conninfo_file="$credential_directory/publisher.conninfo"
  publisher_redacted_conninfo_file="$credential_directory/publisher-redacted.conninfo"
  boardsesh_write_libpq_conninfo PUBLISHER "$publisher_conninfo_file" true
  boardsesh_write_libpq_conninfo PUBLISHER "$publisher_redacted_conninfo_file" false
  boardsesh_md5_conninfo_file "$publisher_conninfo_file"
  publisher_conninfo_digest="$REPLY"
  boardsesh_md5_conninfo_file "$publisher_redacted_conninfo_file"
  publisher_redacted_conninfo_digest="$REPLY"
  SOURCE_REPLICATION_DATABASE_URL=PUBLISHER
fi
unset DATABASE_URL POSTGRES_URL PGPASSWORD

source_missing_included_schemas="$(scalar "$SOURCE_DATABASE_URL" "
SELECT count(*)
FROM (VALUES ${included_schema_values_sql}) AS requested(schema_name)
WHERE pg_catalog.to_regnamespace(requested.schema_name) IS NULL;")"
[[ "$source_missing_included_schemas" == '0' ]] ||
  blocker "source is missing $source_missing_included_schemas schema(s) named by MIGRATION_SCHEMAS"
if [[ -n "$TARGET_DATABASE_URL" ]]; then
  target_missing_included_schemas="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM (VALUES ${included_schema_values_sql}) AS requested(schema_name)
WHERE pg_catalog.to_regnamespace(requested.schema_name) IS NULL;")"
  [[ "$target_missing_included_schemas" == '0' ]] ||
    blocker "target is missing $target_missing_included_schemas schema(s) named by MIGRATION_SCHEMAS"
  target_missing_runtime_schemas="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM (VALUES ${runtime_schema_values_sql}) AS requested(schema_name)
WHERE pg_catalog.to_regnamespace(requested.schema_name) IS NULL;")"
  [[ "$target_missing_runtime_schemas" == '0' ]] ||
    blocker "target is missing $target_missing_runtime_schemas schema(s) named by MIGRATION_RUNTIME_SCHEMAS"
fi

source_tables_file="$audit_directory/source-tables"
source_replication_tables_file="$audit_directory/source-replication-tables"
source_sequences_file="$audit_directory/source-sequences"
source_extensions_file="$audit_directory/source-extensions"
source_schema_file="$audit_directory/source-schema"

printf '# PostgreSQL migration catalog audit\n'
printf 'Connections are intentionally redacted. All catalog queries are read-only.\n'

source_major="$(scalar "$SOURCE_DATABASE_URL" "SELECT current_setting('server_version_num')::integer / 10000;")"
source_version="$(scalar "$SOURCE_DATABASE_URL" "SELECT current_setting('server_version');")"
source_database_name="$(scalar "$SOURCE_DATABASE_URL" 'SELECT current_database();')"
source_wal_level="$(scalar "$SOURCE_DATABASE_URL" 'SHOW wal_level;')"
printf '\nSource: PostgreSQL %s (major %s), wal_level=%s\n' "$source_version" "$source_major" "$source_wal_level"
[[ "$source_major" == "$EXPECTED_SOURCE_MAJOR" ]] ||
  blocker "source major is $source_major; expected $EXPECTED_SOURCE_MAJOR"
[[ "$source_database_name" == "$EXPECTED_SOURCE_DATABASE" ]] ||
  blocker "source database is $source_database_name; expected canonical database $EXPECTED_SOURCE_DATABASE"
[[ "$source_wal_level" == 'logical' ]] ||
  blocker "source wal_level is $source_wal_level; logical replication requires logical"

unknown_schemas="$(unclassified_schemas "$SOURCE_DATABASE_URL")"
[[ -z "$unknown_schemas" ]] ||
  blocker "non-system schema(s) remain unclassified: $unknown_schemas; add each schema, including empty or extension-member namespaces, to the explicit include or exclude policy"

available_replication_slots="$(scalar "$SOURCE_DATABASE_URL" "
SELECT current_setting('max_replication_slots')::integer - count(*)
FROM pg_catalog.pg_replication_slots;")"
[[ "$available_replication_slots" =~ ^-?[0-9]+$ ]] || fail "could not read replication-slot capacity"
available_wal_senders="$(scalar "$SOURCE_DATABASE_URL" "
SELECT current_setting('max_wal_senders')::integer - count(*)
FROM pg_catalog.pg_stat_replication;")"
[[ "$available_wal_senders" =~ ^-?[0-9]+$ ]] || fail "could not read WAL-sender capacity"
if [[ "$REQUIRE_PUBLICATION" != 'true' ]]; then
  [[ "$available_replication_slots" -ge 1 ]] || blocker "source has no free replication slot"
  [[ "$available_wal_senders" -ge 1 ]] || blocker "source has no free WAL sender"
fi
slot_wal_cap="$(scalar "$SOURCE_DATABASE_URL" "SELECT current_setting('max_slot_wal_keep_size');")"
[[ "$slot_wal_cap" != '-1' ]] ||
  blocker "source max_slot_wal_keep_size is unbounded (-1); cap slot retention before creating the migration slot"
printf 'Source replication capacity: free_slots=%s, free_wal_senders=%s, slot_wal_cap=%s\n' \
  "$available_replication_slots" "$available_wal_senders" "$slot_wal_cap"

catalog_tables "$SOURCE_DATABASE_URL" >"$source_tables_file"
replication_tables "$SOURCE_DATABASE_URL" >"$source_replication_tables_file"
sequence_ownership "$SOURCE_DATABASE_URL" >"$source_sequences_file"
extension_manifest "$SOURCE_DATABASE_URL" >"$source_extensions_file"
schema_catalog "$SOURCE_DATABASE_URL" manifest >"$source_schema_file"
source_schema_fingerprint="$(schema_catalog "$SOURCE_DATABASE_URL" fingerprint)"
printf 'Source schema fingerprint: %s\n' "$source_schema_fingerprint"
source_column_acl_count="$(column_acl_count "$SOURCE_DATABASE_URL")"
[[ "$source_column_acl_count" == '0' ]] ||
  blocker "source has $source_column_acl_count included non-extension column ACL(s); --no-acl cannot preserve column grants"
source_unsupported_ddl="$(unsupported_ddl_manifest "$SOURCE_DATABASE_URL")"
if [[ -n "$source_unsupported_ddl" ]]; then
  blocker "source contains DDL classes that are deliberately unsupported by the migration catalog gate: $(paste -sd, <(printf '%s\n' "$source_unsupported_ddl") | sed 's/,/, /g')"
fi

source_drizzle_ledger_exists="$(scalar "$SOURCE_DATABASE_URL" "
SELECT pg_catalog.to_regclass('drizzle.__drizzle_migrations') IS NOT NULL;")"
if [[ "$source_drizzle_ledger_exists" == 't' ]]; then
  source_drizzle_high_water="$(scalar "$SOURCE_DATABASE_URL" "
SELECT count(*)::text || '|' || coalesce(max(created_at), 0)::text || '|' ||
       pg_catalog.md5(coalesce(pg_catalog.string_agg(hash, ',' ORDER BY id), ''))
FROM drizzle.__drizzle_migrations;")"
  printf 'Source Drizzle ledger (count|max(created_at)|hash): %s\n' "$source_drizzle_high_water"
else
  source_drizzle_high_water='MISSING'
  blocker "source is missing drizzle.__drizzle_migrations; schema high-water cannot be fenced"
fi

table_count="$(wc -l <"$source_tables_file" | tr -d ' ')"
[[ "$table_count" -gt 0 ]] || blocker "no persistent application tables matched MIGRATION_SCHEMAS"
printf '\nExplicit publication coverage (%s tables):\n' "$table_count"
publication_tables="$(paste -sd, "$source_tables_file" | sed 's/,/, /g')"
if [[ -n "$publication_tables" ]]; then
  printf 'CREATE PUBLICATION %s FOR TABLE %s;\n' "$MIGRATION_PUBLICATION_NAME" "$publication_tables"
fi

publication_exists="$(scalar "$SOURCE_DATABASE_URL" "
SELECT count(*) FROM pg_catalog.pg_publication WHERE pubname = '${MIGRATION_PUBLICATION_NAME}';")"
if [[ "$publication_exists" == '1' ]]; then
  publication_all_tables="$(scalar "$SOURCE_DATABASE_URL" "
SELECT puballtables FROM pg_catalog.pg_publication WHERE pubname = '${MIGRATION_PUBLICATION_NAME}';")"
  if [[ "$publication_all_tables" == 't' ]]; then
    blocker "publication $MIGRATION_PUBLICATION_NAME uses FOR ALL TABLES; extension tables must stay excluded"
  else
    publication_contract="$(scalar "$SOURCE_DATABASE_URL" "
SELECT pg_catalog.pg_get_userbyid(pubowner) = current_user
       AND pubinsert AND pubupdate AND pubdelete AND pubtruncate AND NOT pubviaroot
FROM pg_catalog.pg_publication
WHERE pubname = '${MIGRATION_PUBLICATION_NAME}';")"
    [[ "$publication_contract" == 't' ]] ||
      blocker "publication must be owned by the audited source credential, include every DML operation, and set publish_via_partition_root=false"
    publication_direct_tables_file="$audit_directory/publication-direct-tables"
    psql_readonly "$SOURCE_DATABASE_URL" -Atq -c "
SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
FROM pg_catalog.pg_publication_rel AS publication_relation
JOIN pg_catalog.pg_publication AS publication ON publication.oid = publication_relation.prpubid
JOIN pg_catalog.pg_class AS relation ON relation.oid = publication_relation.prrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE publication.pubname = '${MIGRATION_PUBLICATION_NAME}'
ORDER BY 1;" >"$publication_direct_tables_file"
    compare_manifests "publication direct table manifest" "$source_tables_file" "$publication_direct_tables_file"
    publication_tables_file="$audit_directory/publication-tables"
    psql_readonly "$SOURCE_DATABASE_URL" -Atq -c "
SELECT pg_catalog.format('%I.%I', schemaname, tablename)
FROM pg_catalog.pg_publication_tables
WHERE pubname = '${MIGRATION_PUBLICATION_NAME}'
ORDER BY 1;" >"$publication_tables_file"
    compare_manifests "publication table coverage" "$source_replication_tables_file" "$publication_tables_file"

    publication_projection_blockers="$(scalar "$SOURCE_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_publication_tables AS publication_table
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.nspname = publication_table.schemaname
JOIN pg_catalog.pg_class AS relation
  ON relation.relnamespace = namespace.oid
 AND relation.relname = publication_table.tablename
WHERE publication_table.pubname = '${MIGRATION_PUBLICATION_NAME}'
  AND (
    publication_table.rowfilter IS NOT NULL
    OR publication_table.attnames IS DISTINCT FROM ARRAY(
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = relation.oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    )
  );")"
    [[ "$publication_projection_blockers" == '0' ]] ||
      blocker "$publication_projection_blockers publication table(s) use a row filter or omit columns; migration publication must copy every row and non-dropped column"
  fi
elif [[ "$REQUIRE_PUBLICATION" == 'true' ]]; then
  blocker "publication $MIGRATION_PUBLICATION_NAME does not exist"
else
  printf 'Publication is not present yet; rerun with REQUIRE_PUBLICATION=true after setup.\n'
fi

if [[ "$REQUIRE_PUBLICATION" == 'true' ]]; then
  source_slot_contract="$(scalar "$SOURCE_DATABASE_URL" "
SELECT count(*) = 1
FROM pg_catalog.pg_replication_slots
WHERE slot_name = '${MIGRATION_SLOT_NAME}'
  AND slot_type = 'logical'
  AND plugin = 'pgoutput'
  AND database = current_database()
  AND active
  AND wal_status <> 'lost';")"
  [[ "$source_slot_contract" == 't' ]] ||
    blocker "source slot $MIGRATION_SLOT_NAME must be one active pgoutput logical slot for the current database"

  if [[ -z "$SOURCE_REPLICATION_DATABASE_URL" ]]; then
    blocker "SOURCE_REPLICATION_DATABASE_URL is required once publication coverage is required"
  else
    publisher_database="$(publisher_scalar 'SELECT current_database();')"
    source_database="$(scalar "$SOURCE_DATABASE_URL" 'SELECT current_database();')"
    [[ "$publisher_database" == "$source_database" ]] ||
      blocker "publisher credential connects to database $publisher_database; source is $source_database"

    publisher_identity="$(psql_publisher_readonly -Atq -F '|' -c 'SELECT session_user, current_user;')"
    [[ "$publisher_identity" == "${BOARDSESH_LIBPQ_PUBLISHER_PGUSER}|${BOARDSESH_LIBPQ_PUBLISHER_PGUSER}" ]] ||
      blocker 'publisher URL must authenticate directly as its restricted role; startup SET ROLE is forbidden'
    publisher_role="$(publisher_scalar 'SELECT current_user;')"
    publisher_contract="$(publisher_scalar "
SELECT rolcanlogin::text || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' ||
       rolcreaterole::text || '|' || rolinherit::text || '|' || rolreplication::text || '|' ||
       rolbypassrls::text || '|' ||
       (SELECT count(*) = 0 FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = publisher.oid OR membership.roleid = publisher.oid)::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
         WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
           AND dependency.refobjid = publisher.oid
           AND dependency.deptype = 'o'
       ))::text || '|' ||
       (NOT pg_catalog.has_database_privilege(
         publisher.oid, current_database(), 'CREATE'
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_namespace AS namespace
         WHERE namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND pg_catalog.has_schema_privilege(publisher.oid, namespace.oid, 'CREATE')
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S')
           AND namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND (
             pg_catalog.has_table_privilege(publisher.oid, relation.oid, 'INSERT')
             OR pg_catalog.has_table_privilege(publisher.oid, relation.oid, 'UPDATE')
             OR pg_catalog.has_table_privilege(publisher.oid, relation.oid, 'DELETE')
             OR pg_catalog.has_table_privilege(publisher.oid, relation.oid, 'TRUNCATE')
             OR pg_catalog.has_table_privilege(publisher.oid, relation.oid, 'REFERENCES')
             OR pg_catalog.has_table_privilege(publisher.oid, relation.oid, 'TRIGGER')
           )
       ))::text
FROM pg_catalog.pg_roles AS publisher
WHERE rolname = current_user;")"
    [[ "$publisher_contract" == 'true|false|false|false|true|true|false|true|true|true|true|true' ]] ||
      blocker "publisher role $publisher_role must be an ownership-free exact replication LOGIN with no role edges or effective database/schema CREATE or relation DML"

    publisher_row_security="$(publisher_scalar 'SHOW row_security;')"
    [[ "$publisher_row_security" == 'off' ]] ||
      blocker "publisher role $publisher_role must connect with row_security=off so future RLS fails closed"

    publisher_select_blockers="$(publisher_scalar "
SELECT count(*)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND relation.relpersistence = 'p'
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(relation.relacl) AS privilege
    WHERE privilege.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
    GROUP BY privilege.grantee
    HAVING count(*) = 1
       AND pg_catalog.bool_and(
         privilege.privilege_type = 'SELECT'
         AND NOT privilege.is_grantable
       )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$publisher_select_blockers" == '0' ]] ||
      blocker "publisher role $publisher_role lacks direct non-grantable SELECT on $publisher_select_blockers published table(s)"

    publisher_schema_usage_blockers="$(publisher_scalar "
SELECT count(*)
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS published_relation
    WHERE published_relation.relnamespace = namespace.oid
      AND published_relation.relkind IN ('r', 'p')
      AND published_relation.relpersistence = 'p'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
        WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND extension_dependency.objid = published_relation.oid
          AND extension_dependency.deptype = 'e'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(namespace.nspacl) AS privilege
    WHERE privilege.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
    GROUP BY privilege.grantee
    HAVING count(*) = 1
       AND pg_catalog.bool_and(
         privilege.privilege_type = 'USAGE'
         AND NOT privilege.is_grantable
       )
  );")"
    [[ "$publisher_schema_usage_blockers" == '0' ]] ||
      blocker "publisher role $publisher_role lacks direct non-grantable USAGE on $publisher_schema_usage_blockers application schema(s)"

    publisher_relation_acl_extras="$(publisher_scalar "
SELECT count(*)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
WHERE privilege.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
  AND NOT (
    relation.relkind IN ('r', 'p')
    AND relation.relpersistence = 'p'
    AND namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND privilege.privilege_type = 'SELECT'
    AND NOT privilege.is_grantable
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND extension_dependency.objid = relation.oid
        AND extension_dependency.deptype = 'e'
    )
  );")"
    [[ "$publisher_relation_acl_extras" == '0' ]] ||
      blocker "publisher role $publisher_role has $publisher_relation_acl_extras direct relation ACL(s) outside exact non-grantable SELECT on the publication manifest"

    publisher_schema_acl_extras="$(publisher_scalar "
SELECT count(*)
FROM pg_catalog.pg_namespace AS namespace
CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
WHERE privilege.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
  AND NOT (
    namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND privilege.privilege_type = 'USAGE'
    AND NOT privilege.is_grantable
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      WHERE relation.relnamespace = namespace.oid
        AND relation.relkind IN ('r', 'p')
        AND relation.relpersistence = 'p'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
          WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND extension_dependency.objid = relation.oid
            AND extension_dependency.deptype = 'e'
        )
    )
  );")"
    [[ "$publisher_schema_acl_extras" == '0' ]] ||
      blocker "publisher role $publisher_role has $publisher_schema_acl_extras direct schema ACL(s) outside exact non-grantable USAGE on publication schemas"

    publisher_column_acl_extras="$(publisher_scalar "
SELECT count(*)
FROM pg_catalog.pg_attribute AS attribute
CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
WHERE attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND privilege.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);")"
    [[ "$publisher_column_acl_extras" == '0' ]] ||
      blocker "publisher role $publisher_role has $publisher_column_acl_extras direct column ACL(s); publication access must use exact table SELECT grants"

    publisher_database_acl_extras="$(publisher_scalar "
SELECT count(*)
FROM pg_catalog.pg_database AS database
CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
WHERE privilege.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);")"
    [[ "$publisher_database_acl_extras" == '0' ]] ||
      blocker "publisher role $publisher_role has $publisher_database_acl_extras direct database ACL(s); connection must rely only on the reviewed cluster baseline"

    publisher_routine_acl_extras="$(publisher_scalar "
SELECT count(*)
FROM pg_catalog.pg_proc AS procedure
CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
WHERE privilege.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);")"
    [[ "$publisher_routine_acl_extras" == '0' ]] ||
      blocker "publisher role $publisher_role has $publisher_routine_acl_extras direct routine ACL(s); publication access is table-only"

    publisher_type_acl_extras="$(publisher_scalar "
SELECT count(*)
FROM pg_catalog.pg_type AS type_row
CROSS JOIN LATERAL pg_catalog.aclexplode(type_row.typacl) AS privilege
WHERE privilege.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);")"
    [[ "$publisher_type_acl_extras" == '0' ]] ||
      blocker "publisher role $publisher_role has $publisher_type_acl_extras direct type ACL(s); publication access is table-only"

    publisher_effective_routine_execute="$(publisher_scalar "
SELECT count(*)
FROM pg_catalog.pg_proc AS procedure
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND pg_catalog.has_function_privilege(current_user, procedure.oid, 'EXECUTE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$publisher_effective_routine_execute" == '0' ]] ||
      blocker "publisher role $publisher_role can effectively EXECUTE $publisher_effective_routine_execute non-extension application routine(s); publication access is table-only"

    # This zero-row access probe deliberately fails when row_security=off and
    # any published table would be filtered by RLS for the publisher role.
    psql_publisher_readonly -Atq <<SQL
SELECT pg_catalog.format('SELECT 1 FROM %I.%I LIMIT 0;', namespace.nspname, relation.relname)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND relation.relpersistence = 'p'
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname
\gexec
SQL
    printf 'Publisher credential: role=%s, row_security=%s, table access probed.\n' \
      "$publisher_role" "$publisher_row_security"
  fi
fi

replica_identity_blockers="$(scalar "$SOURCE_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind = 'r'
  AND relation.relpersistence = 'p'
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND (
    relation.relreplident = 'n'
    OR (
      relation.relreplident = 'd'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_index AS index
        WHERE index.indrelid = relation.oid
          AND index.indisprimary
          AND index.indisvalid
      )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  );")"
[[ "$replica_identity_blockers" == '0' ]] ||
  blocker "$replica_identity_blockers published table(s) lack a usable replica identity for UPDATE/DELETE"

report_query 'Replica identity audit' "$SOURCE_DATABASE_URL" "
SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname) AS relation,
       relation.relreplident AS identity_code,
       coalesce(primary_index.indexrelid::pg_catalog.regclass::text, 'NONE') AS primary_key
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_index AS primary_index
  ON primary_index.indrelid = relation.oid
 AND primary_index.indisprimary
 AND primary_index.indisvalid
WHERE relation.relkind = 'r'
  AND relation.relpersistence = 'p'
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
ORDER BY 1;"

nonpublishable_relations="$(scalar "$SOURCE_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND (relation.relpersistence <> 'p' OR relation.relkind = 'f');")"
[[ "$nonpublishable_relations" == '0' ]] ||
  blocker "$nonpublishable_relations unlogged/temporary/foreign relation(s) are outside the publication contract"

unowned_sequences="$(scalar "$SOURCE_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_class AS sequence_class
JOIN pg_catalog.pg_namespace AS sequence_namespace
  ON sequence_namespace.oid = sequence_class.relnamespace
WHERE sequence_class.relkind = 'S'
  AND sequence_class.relpersistence = 'p'
  AND sequence_namespace.nspname IN (${included_schemas_sql})
  AND sequence_namespace.nspname NOT IN (${excluded_schemas_sql})
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS ownership
    WHERE ownership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND ownership.objid = sequence_class.oid
      AND ownership.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND ownership.deptype IN ('a', 'i')
      AND ownership.refobjsubid > 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = sequence_class.oid
      AND extension_dependency.deptype = 'e'
  );")"
[[ "$unowned_sequences" == '0' ]] ||
  blocker "$unowned_sequences application sequence(s) are unowned and cannot be synchronized by the guarded sequence tool"

report_query 'Owned sequence manifest' "$SOURCE_DATABASE_URL" "
SELECT pg_catalog.format('%I.%I', sequence_namespace.nspname, sequence_class.relname) AS sequence,
       pg_catalog.format('%I.%I', owner_namespace.nspname, owner_class.relname) AS owner_table,
       owner_attribute.attname AS owner_column,
       CASE ownership.deptype WHEN 'i' THEN 'identity' ELSE 'serial' END AS ownership
FROM pg_catalog.pg_class AS sequence_class
JOIN pg_catalog.pg_namespace AS sequence_namespace ON sequence_namespace.oid = sequence_class.relnamespace
JOIN pg_catalog.pg_depend AS ownership
  ON ownership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
 AND ownership.objid = sequence_class.oid
 AND ownership.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
 AND ownership.deptype IN ('a', 'i')
 AND ownership.refobjsubid > 0
JOIN pg_catalog.pg_class AS owner_class ON owner_class.oid = ownership.refobjid
JOIN pg_catalog.pg_namespace AS owner_namespace ON owner_namespace.oid = owner_class.relnamespace
JOIN pg_catalog.pg_attribute AS owner_attribute
  ON owner_attribute.attrelid = owner_class.oid
 AND owner_attribute.attnum = ownership.refobjsubid
 AND NOT owner_attribute.attisdropped
WHERE sequence_class.relkind = 'S'
  AND sequence_namespace.nspname IN (${included_schemas_sql})
  AND sequence_namespace.nspname NOT IN (${excluded_schemas_sql})
ORDER BY 1;"

prepared_transactions="$(scalar "$SOURCE_DATABASE_URL" 'SELECT count(*) FROM pg_catalog.pg_prepared_xacts;')"
[[ "$prepared_transactions" == '0' ]] ||
  blocker "$prepared_transactions prepared transaction(s) must be resolved before the migration snapshot/cutover"

large_objects="$(scalar "$SOURCE_DATABASE_URL" 'SELECT count(*) FROM pg_catalog.pg_largeobject_metadata;')"
[[ "$large_objects" == '0' ]] ||
  blocker "$large_objects large object(s) are not covered by logical replication"

materialized_views="$(scalar "$SOURCE_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind = 'm'
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql});")"
if [[ "$materialized_views" != '0' && "$MATERIALIZED_VIEWS_REFRESH_PLANNED" != 'true' ]]; then
  blocker "$materialized_views materialized view(s) require an explicit target refresh/verification plan"
fi
report_query 'Materialized views' "$SOURCE_DATABASE_URL" "
SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname) AS materialized_view,
       relation.relispopulated,
       pg_catalog.format('REFRESH MATERIALIZED VIEW %I.%I;', namespace.nspname, relation.relname) AS target_refresh
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind = 'm'
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
ORDER BY 1;"

postgis_version="$(scalar "$SOURCE_DATABASE_URL" "
SELECT coalesce(
  (SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'postgis'),
  'MISSING'
);")"
[[ "$postgis_version" != 'MISSING' ]] || blocker "source does not have the required postgis extension"
[[ "$postgis_version" == "$EXPECTED_POSTGIS_VERSION" ]] ||
  blocker "source PostGIS is $postgis_version; the PG18 target is pinned to $EXPECTED_POSTGIS_VERSION and extension downgrade/format compatibility is not assumed"

required_extension_count="$(scalar "$SOURCE_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_extension
  WHERE extname IN ('postgis', 'uuid-ossp', 'pg_trgm');")"
[[ "$required_extension_count" == '3' ]] ||
  blocker "source must have postgis, uuid-ossp, and pg_trgm installed"

report_query 'Extensions' "$SOURCE_DATABASE_URL" "
SELECT extension.extname,
       extension.extversion,
       namespace.nspname AS schema,
       extension.extrelocatable
FROM pg_catalog.pg_extension AS extension
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
ORDER BY extension.extname;"

report_query 'Roles and attributes' "$SOURCE_DATABASE_URL" "
SELECT role.rolname,
       role.rolcanlogin,
       role.rolsuper,
       role.rolreplication,
       role.rolbypassrls,
       role.rolconnlimit
FROM pg_catalog.pg_roles AS role
WHERE role.oid >= 16384
   OR role.rolname = current_user
   OR role.rolreplication
ORDER BY role.rolname;"

report_query 'Application object owners' "$SOURCE_DATABASE_URL" "
SELECT pg_catalog.pg_get_userbyid(relation.relowner) AS owner,
       count(*) AS object_count
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
GROUP BY relation.relowner
ORDER BY owner;"

report_query 'Explicit table and sequence grants' "$SOURCE_DATABASE_URL" "
SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname) AS object,
       CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
       acl.privilege_type,
       acl.is_grantable
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl
WHERE relation.relkind IN ('r', 'p', 'S')
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
ORDER BY 1, 2, 3;"

report_query 'Schema owners and grants' "$SOURCE_DATABASE_URL" "
SELECT namespace.nspname AS schema,
       pg_catalog.pg_get_userbyid(namespace.nspowner) AS owner,
       namespace.nspacl
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (${included_schemas_sql})
ORDER BY namespace.nspname;"

report_query 'Function owners, security mode, and grants' "$SOURCE_DATABASE_URL" "
SELECT namespace.nspname AS schema,
       procedure.proname,
       pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS arguments,
       pg_catalog.pg_get_userbyid(procedure.proowner) AS owner,
       procedure.prosecdef AS security_definer,
       procedure.proacl
FROM pg_catalog.pg_proc AS procedure
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY 1, 2, 3;"

report_query 'User-defined type owners' "$SOURCE_DATABASE_URL" "
SELECT namespace.nspname AS schema,
       type.typname,
       type.typtype,
       pg_catalog.pg_get_userbyid(type.typowner) AS owner
FROM pg_catalog.pg_type AS type
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type.typnamespace
WHERE namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND type.typrelid = 0
  AND type.typtype IN ('c', 'd', 'e', 'm', 'r')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
      AND extension_dependency.objid = type.oid
      AND extension_dependency.deptype = 'e'
  )
ORDER BY 1, 2;"

report_query 'Default privileges' "$SOURCE_DATABASE_URL" "
SELECT pg_catalog.pg_get_userbyid(default_acl.defaclrole) AS owner,
       coalesce(namespace.nspname, 'ALL SCHEMAS') AS schema,
       default_acl.defaclobjtype AS object_type,
       CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
       acl.privilege_type,
       acl.is_grantable
FROM pg_catalog.pg_default_acl AS default_acl
LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS acl
WHERE namespace.nspname IS NULL
   OR namespace.nspname IN (${included_schemas_sql})
ORDER BY 1, 2, 3, 4, 5;"

report_query 'Row-level security and policies' "$SOURCE_DATABASE_URL" "
SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname) AS relation,
       relation.relrowsecurity,
       relation.relforcerowsecurity,
       policy.polname,
       policy.polcmd,
       policy.polpermissive,
       pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
       pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_policy AS policy ON policy.polrelid = relation.oid
WHERE relation.relkind IN ('r', 'p')
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND (relation.relrowsecurity OR policy.oid IS NOT NULL)
ORDER BY 1, policy.polname;"

if [[ -n "$TARGET_DATABASE_URL" ]]; then
  target_tables_file="$audit_directory/target-tables"
  target_sequences_file="$audit_directory/target-sequences"
  target_extensions_file="$audit_directory/target-extensions"
  target_schema_file="$audit_directory/target-schema"

  target_version_num="$(scalar "$TARGET_DATABASE_URL" "SELECT current_setting('server_version_num');")"
  target_major="$((target_version_num / 10000))"
  target_version="$(scalar "$TARGET_DATABASE_URL" "SELECT current_setting('server_version');")"
  target_database_name="$(scalar "$TARGET_DATABASE_URL" 'SELECT current_database();')"
  target_checksums="$(scalar "$TARGET_DATABASE_URL" 'SHOW data_checksums;')"
  printf '\nTarget: PostgreSQL %s (major %s), data_checksums=%s\n' "$target_version" "$target_major" "$target_checksums"
  [[ "$target_major" == "$EXPECTED_TARGET_MAJOR" ]] ||
    blocker "target major is $target_major; expected $EXPECTED_TARGET_MAJOR"
  [[ "$target_database_name" == "$EXPECTED_TARGET_DATABASE" ]] ||
    blocker "target database is $target_database_name; expected canonical database $EXPECTED_TARGET_DATABASE"
  [[ "$target_version_num" == "$EXPECTED_TARGET_VERSION_NUM" ]] ||
    blocker "target server_version_num is $target_version_num ($target_version); expected $EXPECTED_TARGET_VERSION_NUM"
  [[ "$target_checksums" == 'on' ]] || blocker "target data_checksums is $target_checksums; expected on"

  target_unknown_schemas="$(unclassified_schemas "$TARGET_DATABASE_URL")"
  [[ -z "$target_unknown_schemas" ]] ||
    blocker "target has non-extension objects in unclassified schema(s): $target_unknown_schemas"
  target_unsupported_ddl="$(unsupported_ddl_manifest "$TARGET_DATABASE_URL")"
  if [[ -n "$target_unsupported_ddl" ]]; then
    blocker "target contains DDL classes that are deliberately unsupported by the migration catalog gate: $(paste -sd, <(printf '%s\n' "$target_unsupported_ddl") | sed 's/,/, /g')"
  fi

  catalog_tables "$TARGET_DATABASE_URL" >"$target_tables_file"
  sequence_ownership "$TARGET_DATABASE_URL" >"$target_sequences_file"
  extension_manifest "$TARGET_DATABASE_URL" >"$target_extensions_file"
  compare_manifests 'application table catalog' "$source_tables_file" "$target_tables_file"
  compare_manifests 'sequence ownership catalog' "$source_sequences_file" "$target_sequences_file"
  missing_target_extensions_file="$audit_directory/missing-target-extensions"
  comm -23 "$source_extensions_file" "$target_extensions_file" >"$missing_target_extensions_file"
  if [[ -s "$missing_target_extensions_file" ]]; then
    blocker "target is missing or mismatches source extension definition(s): $(paste -sd, "$missing_target_extensions_file" | sed 's/,/, /g')"
  fi

  if [[ "$REQUIRE_PUBLICATION" == 'true' ]]; then
    subscription_count="$(scalar "$TARGET_DATABASE_URL" 'SELECT count(*) FROM pg_catalog.pg_subscription;')"
    [[ "$subscription_count" == '1' ]] ||
      blocker "target must contain exactly one migration subscription; found $subscription_count"

    if [[ -z "$MIGRATION_SUBSCRIBER_ROLE" ]]; then
      blocker "MIGRATION_SUBSCRIBER_ROLE is required for target subscription audit"
    else
      require_identifier MIGRATION_SUBSCRIBER_ROLE "$MIGRATION_SUBSCRIBER_ROLE"
      subscription_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*) = 1
FROM pg_catalog.pg_subscription AS subscription
WHERE subscription.subname = '${MIGRATION_SUBSCRIPTION_NAME}'
  AND pg_catalog.pg_get_userbyid(subscription.subowner) = '${MIGRATION_SUBSCRIBER_ROLE}'
  AND subscription.subenabled
  AND NOT subscription.subbinary
  AND subscription.suborigin = 'none'
  AND NOT subscription.subrunasowner
  AND subscription.subpasswordrequired
  AND NOT subscription.subfailover
  AND subscription.subslotname = '${MIGRATION_SLOT_NAME}'
  AND subscription.subpublications = ARRAY['${MIGRATION_PUBLICATION_NAME}']::text[]
  AND pg_catalog.md5(subscription.subconninfo) = '${publisher_conninfo_digest}'
  AND pg_catalog.obj_description(subscription.oid, 'pg_subscription') =
      'boardsesh-pg18-conninfo-v1:${publisher_redacted_conninfo_digest}';")"
      [[ "$subscription_contract" == 't' ]] ||
        blocker "target subscription owner/options/publication/slot/canonical connection contract differs"
    fi

    target_subscription_tables_file="$audit_directory/target-subscription-tables"
    psql_readonly "$TARGET_DATABASE_URL" -Atq -c "
SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
FROM pg_catalog.pg_subscription_rel AS subscription_relation
JOIN pg_catalog.pg_subscription AS subscription ON subscription.oid = subscription_relation.srsubid
JOIN pg_catalog.pg_class AS relation ON relation.oid = subscription_relation.srrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE subscription.subname = '${MIGRATION_SUBSCRIPTION_NAME}'
ORDER BY 1;" >"$target_subscription_tables_file"
    compare_manifests 'target subscription table coverage' "$source_replication_tables_file" "$target_subscription_tables_file"

    nonready_subscription_tables="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_subscription_rel AS subscription_relation
JOIN pg_catalog.pg_subscription AS subscription ON subscription.oid = subscription_relation.srsubid
WHERE subscription.subname = '${MIGRATION_SUBSCRIPTION_NAME}'
  AND subscription_relation.srsubstate <> 'r';")"
    [[ "$nonready_subscription_tables" == '0' ]] ||
      blocker "$nonready_subscription_tables target subscription table(s) are not ready"
  else
    subscription_count="$(scalar "$TARGET_DATABASE_URL" 'SELECT count(*) FROM pg_catalog.pg_subscription;')"
    [[ "$subscription_count" == '0' ]] ||
      blocker "target must have no logical subscriptions unless REQUIRE_PUBLICATION=true; found $subscription_count"
  fi

  schema_catalog "$TARGET_DATABASE_URL" manifest >"$target_schema_file"
  target_schema_fingerprint="$(schema_catalog "$TARGET_DATABASE_URL" fingerprint)"
  printf 'Target schema fingerprint: %s\n' "$target_schema_fingerprint"
  compare_manifests 'catalog DDL manifest' "$source_schema_file" "$target_schema_file"
  target_column_acl_count="$(column_acl_count "$TARGET_DATABASE_URL")"
  [[ "$target_column_acl_count" == '0' ]] ||
    blocker "target has $target_column_acl_count included non-extension column ACL(s); exact post-restore ACL reconstruction forbids column grants"

  target_drizzle_ledger_exists="$(scalar "$TARGET_DATABASE_URL" "
SELECT pg_catalog.to_regclass('drizzle.__drizzle_migrations') IS NOT NULL;")"
  if [[ "$target_drizzle_ledger_exists" == 't' ]]; then
    target_drizzle_high_water="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)::text || '|' || coalesce(max(created_at), 0)::text || '|' ||
       pg_catalog.md5(coalesce(pg_catalog.string_agg(hash, ',' ORDER BY id), ''))
FROM drizzle.__drizzle_migrations;")"
    [[ "$target_drizzle_high_water" == "$source_drizzle_high_water" ]] ||
      blocker "Drizzle migration ledger high-water differs (source=$source_drizzle_high_water target=$target_drizzle_high_water)"
  else
    blocker "target is missing drizzle.__drizzle_migrations"
  fi

  target_postgis_version="$(scalar "$TARGET_DATABASE_URL" "
SELECT coalesce(
  (SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'postgis'),
  'MISSING'
);")"
  [[ "$target_postgis_version" == "$EXPECTED_POSTGIS_VERSION" ]] ||
    blocker "target PostGIS is $target_postgis_version; expected $EXPECTED_POSTGIS_VERSION"

  if [[ -z "$MIGRATION_OWNER_ROLE" || -z "$MIGRATION_RUNTIME_ROLE" || -z "$MIGRATION_MIGRATOR_ROLE" || -z "$MIGRATION_REPLICATION_ROLE" ]]; then
    blocker "MIGRATION_OWNER_ROLE, MIGRATION_RUNTIME_ROLE, MIGRATION_MIGRATOR_ROLE, and MIGRATION_REPLICATION_ROLE are all required for target comparison"
  else
    require_identifier MIGRATION_OWNER_ROLE "$MIGRATION_OWNER_ROLE"
    require_identifier MIGRATION_RUNTIME_ROLE "$MIGRATION_RUNTIME_ROLE"
    require_identifier MIGRATION_MIGRATOR_ROLE "$MIGRATION_MIGRATOR_ROLE"
    require_identifier MIGRATION_REPLICATION_ROLE "$MIGRATION_REPLICATION_ROLE"

    required_roles=(
      "$MIGRATION_OWNER_ROLE"
      "$MIGRATION_RUNTIME_ROLE"
      "$MIGRATION_MIGRATOR_ROLE"
      "$MIGRATION_REPLICATION_ROLE"
      "$MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE"
    )
    if [[ -n "$MIGRATION_SNAPSHOT_COORDINATOR_ROLE" ]]; then
      required_roles+=("$MIGRATION_SNAPSHOT_COORDINATOR_ROLE")
    fi
    if [[ "$REQUIRE_PUBLICATION" == 'true' && -n "$MIGRATION_SUBSCRIBER_ROLE" ]]; then
      required_roles+=("$MIGRATION_SUBSCRIBER_ROLE")
    fi
    for additional_role in $MIGRATION_REQUIRED_ROLES; do
      required_roles+=("$additional_role")
    done

    for required_role in "${required_roles[@]}"; do
      require_identifier MIGRATION_REQUIRED_ROLES "$required_role"
      role_exists="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = '${required_role}';")"
      [[ "$role_exists" == '1' ]] || blocker "required target role $required_role is missing"
    done

    owner_role_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT rolcanlogin::text || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' ||
       rolcreaterole::text || '|' || rolinherit::text || '|' || rolreplication::text || '|' || rolbypassrls::text
FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_OWNER_ROLE}';")"
    runtime_role_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT rolcanlogin::text || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' ||
       rolcreaterole::text || '|' || rolinherit::text || '|' || rolreplication::text || '|' || rolbypassrls::text
FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_RUNTIME_ROLE}';")"
    migrator_role_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT rolcanlogin::text || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' ||
       rolcreaterole::text || '|' || rolinherit::text || '|' || rolreplication::text || '|' || rolbypassrls::text
FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_MIGRATOR_ROLE}';")"
    replication_role_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT rolcanlogin::text || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' ||
       rolcreaterole::text || '|' || rolinherit::text || '|' || rolreplication::text || '|' || rolbypassrls::text
FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_REPLICATION_ROLE}';")"
    snapshot_fence_owner_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT rolcanlogin::text || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' ||
       rolcreaterole::text || '|' || rolinherit::text || '|' || rolreplication::text || '|' ||
       rolbypassrls::text
FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}';")"
    [[ "$owner_role_contract" == 'false|false|false|false|true|false|false' ]] ||
      blocker "owner role must be NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, INHERIT, NOREPLICATION, and NOBYPASSRLS"
    owner_database_create="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*) = 1
  AND pg_catalog.bool_and(
    privilege.privilege_type = 'CREATE'
    AND NOT privilege.is_grantable
  )
FROM pg_catalog.pg_database AS database
JOIN pg_catalog.pg_roles AS owner_role ON owner_role.rolname = '${MIGRATION_OWNER_ROLE}'
CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
WHERE database.datname = current_database()
  AND database.datdba <> owner_role.oid
  AND privilege.grantee = owner_role.oid;")"
    [[ "$owner_database_create" == 't' ]] ||
      blocker "owner role needs exactly one direct non-grantable CREATE ACL and no other direct target-database privilege"
    [[ "$runtime_role_contract" == 'true|false|false|false|true|false|false' ]] ||
      blocker "runtime role must be LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, INHERIT, NOREPLICATION, and NOBYPASSRLS"
    [[ "$migrator_role_contract" == 'true|false|false|false|true|false|false' ]] ||
      blocker "migrator role must be LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, INHERIT, NOREPLICATION, and NOBYPASSRLS"
    [[ "$replication_role_contract" == 'true|false|false|false|true|true|false' ]] ||
      blocker "replication role must be LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, INHERIT, REPLICATION, and NOBYPASSRLS"
    runtime_and_replication_membership_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*) = 0
FROM pg_catalog.pg_auth_members AS membership
WHERE membership.member IN (
  SELECT oid FROM pg_catalog.pg_roles
  WHERE rolname IN ('${MIGRATION_RUNTIME_ROLE}', '${MIGRATION_REPLICATION_ROLE}')
) OR membership.roleid IN (
  SELECT oid FROM pg_catalog.pg_roles
  WHERE rolname IN ('${MIGRATION_RUNTIME_ROLE}', '${MIGRATION_REPLICATION_ROLE}')
);")"
    [[ "$runtime_and_replication_membership_contract" == 't' ]] ||
      blocker "runtime and replication roles must have no incoming or outgoing direct role memberships"
    restricted_login_ddl_contract="$(scalar "$TARGET_DATABASE_URL" "
WITH restricted_role AS (
  SELECT oid, rolname FROM pg_catalog.pg_roles
  WHERE rolname IN (
    '${MIGRATION_RUNTIME_ROLE}', '${MIGRATION_MIGRATOR_ROLE}', '${MIGRATION_REPLICATION_ROLE}'
  )
)
SELECT count(*) = 3 AND pg_catalog.bool_and(
         NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_database AS database
           WHERE database.datdba = restricted_role.oid
         )
         AND NOT pg_catalog.has_database_privilege(
           restricted_role.oid, current_database(), 'CREATE'
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_namespace AS namespace
           WHERE namespace.nspname <> 'information_schema'
             AND namespace.nspname !~ '^pg_'
             AND pg_catalog.has_schema_privilege(
               restricted_role.oid, namespace.oid, 'CREATE'
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
           WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
             AND dependency.refobjid = restricted_role.oid
             AND dependency.deptype = 'o'
         )
       )
FROM restricted_role;")"
    [[ "$restricted_login_ddl_contract" == 't' ]] ||
      blocker "runtime/migrator/replication LOGIN roles must not own objects or have effective database/application-schema CREATE"

    expected_owner_incoming_count=1
    allowed_owner_members="'${MIGRATION_MIGRATOR_ROLE}'"
    if [[ "$REQUIRE_PUBLICATION" == 'true' && -n "$MIGRATION_SUBSCRIBER_ROLE" ]]; then
      expected_owner_incoming_count=2
      allowed_owner_members+=", '${MIGRATION_SUBSCRIBER_ROLE}'"
    fi
    migrator_owner_membership_contract="$(scalar "$TARGET_DATABASE_URL" "
WITH owner_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_OWNER_ROLE}'
), migrator_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_MIGRATOR_ROLE}'
)
SELECT (
         SELECT count(*) = 1 AND pg_catalog.bool_and(
                  membership.roleid = owner_role.oid
                  AND NOT membership.admin_option
                  AND NOT membership.inherit_option
                  AND membership.set_option
                )
         FROM pg_catalog.pg_auth_members AS membership, owner_role, migrator_role
         WHERE membership.member = migrator_role.oid
       )
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
         JOIN owner_role ON owner_role.oid = membership.roleid
         JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
         WHERE member_role.rolname NOT IN (${allowed_owner_members})
            OR membership.admin_option
            OR membership.inherit_option
            OR NOT membership.set_option
       )
       AND (
         SELECT count(*) = ${expected_owner_incoming_count}
         FROM pg_catalog.pg_auth_members AS membership, owner_role
         WHERE membership.roleid = owner_role.oid
       )
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members AS membership, migrator_role
         WHERE membership.roleid = migrator_role.oid
       );")"
    [[ "$migrator_owner_membership_contract" == 't' ]] ||
      blocker "owner role graph must have the exact migrator and active-subscription-only subscriber SET-only/no-admin incoming edges"
    [[ "$snapshot_fence_owner_contract" == 'false|false|false|false|true|false|false' ]] ||
      blocker "snapshot fence owner must be NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, INHERIT, NOREPLICATION, and NOBYPASSRLS"

    snapshot_fence_stats_contract="$(scalar "$TARGET_DATABASE_URL" "
WITH fence_owner AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'
), stats_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'pg_read_all_stats'
)
SELECT count(*) = 1
FROM pg_catalog.pg_auth_members AS membership, fence_owner, stats_role
WHERE membership.member = fence_owner.oid
  AND membership.roleid = stats_role.oid
  AND NOT membership.admin_option
  AND membership.inherit_option
  AND NOT membership.set_option;")"
    [[ "$snapshot_fence_stats_contract" == 't' ]] ||
      blocker "snapshot fence owner must inherit pg_read_all_stats without ADMIN or SET OPTION"

    snapshot_fence_owner_membership_contract="$(scalar "$TARGET_DATABASE_URL" "
WITH fence_owner AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'
), application_owner AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_OWNER_ROLE}'
)
SELECT count(*) FILTER (
         WHERE membership.roleid = fence_owner.oid
           AND NOT membership.admin_option
           AND NOT membership.inherit_option
           AND membership.set_option
       ) = 1
       AND count(*) = 1
FROM pg_catalog.pg_auth_members AS membership, fence_owner, application_owner
WHERE membership.member = application_owner.oid;")"
    [[ "$snapshot_fence_owner_membership_contract" == 't' ]] ||
      blocker "app owner must have exactly one direct role membership: SET-only in the snapshot fence owner"

    snapshot_fence_membership_boundary_contract="$(scalar "$TARGET_DATABASE_URL" "
WITH fence_owner AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'
)
SELECT count(*) = 2
FROM pg_catalog.pg_auth_members AS membership, fence_owner
WHERE membership.member = fence_owner.oid
   OR membership.roleid = fence_owner.oid;")"
    [[ "$snapshot_fence_membership_boundary_contract" == 't' ]] ||
      blocker "snapshot fence owner must have exactly the two direct membership edges in the role contract"

    snapshot_fence_control_function_contract="$(scalar "$TARGET_DATABASE_URL" "
WITH fence_owner AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'
), expected(function_oid) AS (
  VALUES
    ('pg_catalog.pg_control_system()'::pg_catalog.regprocedure),
    ('pg_catalog.pg_control_checkpoint()'::pg_catalog.regprocedure)
)
SELECT count(*) = 2 AND pg_catalog.bool_and(
         per_function.direct_execute_count = 1
         AND per_function.non_grantable_execute_count = 1
         AND per_function.public_execute_count = 0
       )
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
  FROM expected
  JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = expected.function_oid
  CROSS JOIN fence_owner
  LEFT JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege ON true
  GROUP BY expected.function_oid
) AS per_function;")"
    [[ "$snapshot_fence_control_function_contract" == 't' ]] ||
      blocker "snapshot fence owner lacks exact direct non-grantable EXECUTE ACLs on pg_control_system() or pg_control_checkpoint()"

    snapshot_fence_function_acl_boundary="$(scalar "$TARGET_DATABASE_URL" "
WITH fence_owner AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'
), allowed(function_oid) AS (
  VALUES
    ('pg_catalog.pg_control_system()'::pg_catalog.regprocedure),
    ('pg_catalog.pg_control_checkpoint()'::pg_catalog.regprocedure),
    (pg_catalog.to_regprocedure('ops.board_snapshot_cluster_identity()')),
    (pg_catalog.to_regprocedure('ops.acquire_board_snapshot_fence(integer)'))
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
         ) AS non_grantable_execute_count
  FROM allowed
  JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = allowed.function_oid
  CROSS JOIN fence_owner
  LEFT JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege ON true
  GROUP BY allowed.function_oid
)
SELECT (
         SELECT count(*) = (SELECT count(*) FROM allowed WHERE function_oid IS NOT NULL)
           AND pg_catalog.bool_and(
             direct_execute_count = 1 AND non_grantable_execute_count = 1
           )
         FROM per_function
       )
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS procedure
         CROSS JOIN fence_owner
         CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
         WHERE privilege.grantee = fence_owner.oid
           AND privilege.privilege_type = 'EXECUTE'
           AND NOT EXISTS (
             SELECT 1 FROM allowed WHERE allowed.function_oid = procedure.oid
           )
       );")"
    [[ "$snapshot_fence_function_acl_boundary" == 't' ]] ||
      blocker "snapshot fence owner has a direct function EXECUTE ACL outside the four-function boundary"

    snapshot_ops_schema_exists="$(scalar "$TARGET_DATABASE_URL" "
SELECT pg_catalog.to_regnamespace('ops') IS NOT NULL;")"
    if [[ "$snapshot_ops_schema_exists" == 't' ]]; then
      snapshot_fence_schema_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*) = 2
FROM pg_catalog.pg_namespace AS namespace
JOIN pg_catalog.pg_roles AS fence_owner
  ON fence_owner.rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'
CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
WHERE namespace.nspname = 'ops'
  AND privilege.grantee = fence_owner.oid
  AND privilege.privilege_type IN ('USAGE', 'CREATE')
  AND NOT privilege.is_grantable;")"
      [[ "$snapshot_fence_schema_contract" == 't' ]] ||
        blocker "snapshot fence owner needs USAGE and CREATE on ops to accept function ownership"

      snapshot_security_definer_contract="$(scalar "$TARGET_DATABASE_URL" "
WITH expected(signature) AS (
  VALUES
    ('ops.board_snapshot_cluster_identity()'::pg_catalog.regprocedure),
    ('ops.acquire_board_snapshot_fence(integer)'::pg_catalog.regprocedure)
)
SELECT count(*) = 2
FROM expected
JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = expected.signature
WHERE procedure.prosecdef
  AND pg_catalog.pg_get_userbyid(procedure.proowner) = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS privilege
    WHERE privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  );")"
      [[ "$snapshot_security_definer_contract" == 't' ]] ||
        blocker "snapshot SECURITY DEFINER functions must have the dedicated fence owner and no PUBLIC EXECUTE grant"
    fi

    snapshot_fence_ownership_acl_boundary="$(scalar "$TARGET_DATABASE_URL" "
WITH fence_owner AS (
  SELECT oid FROM pg_catalog.pg_roles
  WHERE rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'
)
SELECT (NOT pg_catalog.has_database_privilege(
         fence_owner.oid, current_database(), 'CREATE'
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_namespace AS namespace
         WHERE namespace.nspname <> 'ops'
           AND namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND pg_catalog.has_schema_privilege(fence_owner.oid, namespace.oid, 'CREATE')
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_database AS database
         CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
         WHERE privilege.grantee = fence_owner.oid
       ))::text || '|' ||
       ((NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_namespace AS namespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
         WHERE privilege.grantee = fence_owner.oid
           AND NOT (
             namespace.nspname = 'ops'
             AND privilege.privilege_type IN ('USAGE', 'CREATE')
             AND NOT privilege.is_grantable
           )
       )) AND (
         SELECT count(*) = CASE
                  WHEN pg_catalog.to_regnamespace('ops') IS NULL THEN 0 ELSE 2
                END
                AND coalesce(pg_catalog.bool_and(
                  privilege.privilege_type IN ('USAGE', 'CREATE')
                  AND NOT privilege.is_grantable
                ), true)
         FROM pg_catalog.pg_namespace AS namespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
         WHERE namespace.nspname = 'ops'
           AND privilege.grantee = fence_owner.oid
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
         WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
           AND dependency.refobjid = fence_owner.oid
           AND dependency.deptype = 'o'
           AND NOT (
             dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
             AND dependency.objid IN (
               coalesce(pg_catalog.to_regprocedure('ops.board_snapshot_cluster_identity()'), 0::pg_catalog.oid),
               coalesce(pg_catalog.to_regprocedure('ops.acquire_board_snapshot_fence(integer)'), 0::pg_catalog.oid)
             )
           )
       ))::text || '|' ||
       ((NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_class AS relation
         CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
         WHERE privilege.grantee = fence_owner.oid
       )) AND (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_type AS type_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(type_row.typacl) AS privilege
         WHERE privilege.grantee = fence_owner.oid
       )) AND (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_attribute AS attribute
         CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
         WHERE attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND privilege.grantee = fence_owner.oid
       )))::text
FROM fence_owner;")"
    [[ "$snapshot_fence_ownership_acl_boundary" == 'true|true|true|true|true|true' ]] ||
      blocker "snapshot fence owner has unexpected database/schema/object ownership or a direct ACL outside its ops/function/column allowlist"

    runtime_fence_escalation_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT NOT pg_catalog.pg_has_role(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_RUNTIME_ROLE}'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'),
         'SET'
       )
       AND NOT pg_catalog.pg_has_role(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_RUNTIME_ROLE}'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'),
         'USAGE'
       )
       AND (
         pg_catalog.to_regnamespace('ops') IS NULL
         OR NOT pg_catalog.has_schema_privilege(
           (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_RUNTIME_ROLE}'),
           'ops',
           'CREATE'
         )
       );")"
    [[ "$runtime_fence_escalation_contract" == 't' ]] ||
      blocker "runtime role can SET/USE the snapshot fence owner or CREATE in ops"

    if [[ -n "$MIGRATION_SNAPSHOT_COORDINATOR_ROLE" ]]; then
      snapshot_coordinator_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT NOT pg_catalog.pg_has_role(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_COORDINATOR_ROLE}'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'),
         'SET'
       )
       AND NOT pg_catalog.pg_has_role(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_COORDINATOR_ROLE}'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'),
         'USAGE'
       )
       AND (
         pg_catalog.to_regnamespace('ops') IS NULL
         OR NOT pg_catalog.has_schema_privilege(
           (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SNAPSHOT_COORDINATOR_ROLE}'),
           'ops',
           'CREATE'
         )
       );")"
      [[ "$snapshot_coordinator_contract" == 't' ]] ||
        blocker "snapshot coordinator can SET/USE the fence owner or CREATE in ops"
    fi

    migrator_can_set_owner="$(scalar "$TARGET_DATABASE_URL" "
WITH owner_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_OWNER_ROLE}'
), member_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_MIGRATOR_ROLE}'
)
SELECT count(*) FILTER (
         WHERE membership.roleid = owner_role.oid
           AND NOT membership.admin_option
           AND NOT membership.inherit_option
           AND membership.set_option
       ) = 1
       AND count(*) = 1
FROM pg_catalog.pg_auth_members AS membership, owner_role, member_role
WHERE membership.member = member_role.oid;")"
    [[ "$migrator_can_set_owner" == 't' ]] ||
      blocker "migrator role cannot SET ROLE to the NOLOGIN app owner"

    if [[ "$REQUIRE_PUBLICATION" == 'true' && -n "$MIGRATION_SUBSCRIBER_ROLE" ]]; then
      subscriber_role_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT role.rolcanlogin::text || '|' || role.rolsuper::text || '|' || role.rolcreatedb::text || '|' ||
       role.rolcreaterole::text || '|' || role.rolinherit::text || '|' || role.rolreplication::text || '|' ||
       role.rolbypassrls::text || '|' || (auth.rolpassword IS NULL)::text
FROM pg_catalog.pg_roles AS role
JOIN pg_catalog.pg_authid AS auth ON auth.oid = role.oid
WHERE role.rolname = '${MIGRATION_SUBSCRIBER_ROLE}';")"
      [[ "$subscriber_role_contract" == 'true|false|false|false|true|false|false|true' ]] ||
        blocker "subscriber owner must be a passwordless LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, INHERIT, NOREPLICATION, and NOBYPASSRLS"

      subscriber_can_set_owner="$(scalar "$TARGET_DATABASE_URL" "
WITH owner_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_OWNER_ROLE}'
), subscriber_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SUBSCRIBER_ROLE}'
)
SELECT count(*) FILTER (
         WHERE membership.roleid = owner_role.oid
           AND NOT membership.admin_option
           AND NOT membership.inherit_option
           AND membership.set_option
       ) = 1
       AND count(*) FILTER (WHERE membership.roleid = owner_role.oid) = 1
       AND count(*) = 2
FROM pg_catalog.pg_auth_members AS membership, owner_role, subscriber_role
WHERE membership.member = subscriber_role.oid;")"
      [[ "$subscriber_can_set_owner" == 't' ]] ||
        blocker "subscriber owner cannot SET ROLE to the application object owner while run_as_owner=false"

      subscriber_create_contract="$(scalar "$TARGET_DATABASE_URL" "
SELECT (
         SELECT count(*) = 1
           AND pg_catalog.bool_and(
             privilege.privilege_type = 'CREATE'
             AND NOT privilege.is_grantable
           )
         FROM pg_catalog.pg_database AS database
         CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
         WHERE database.datname = current_database()
           AND privilege.grantee = subscriber.oid
       )
       AND (
         SELECT count(*) = 1
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.member = subscriber.oid
           AND membership.roleid = create_subscription_role.oid
           AND NOT membership.admin_option
           AND membership.inherit_option
           AND NOT membership.set_option
       )
FROM pg_catalog.pg_roles AS subscriber
CROSS JOIN pg_catalog.pg_roles AS create_subscription_role
WHERE subscriber.rolname = '${MIGRATION_SUBSCRIBER_ROLE}'
  AND create_subscription_role.rolname = 'pg_create_subscription';")"
      [[ "$subscriber_create_contract" == 't' ]] ||
        blocker "subscriber owner lacks direct non-grantable database CREATE or exact direct pg_create_subscription membership"

      subscriber_boundary_contract="$(scalar "$TARGET_DATABASE_URL" "
WITH subscriber AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_SUBSCRIBER_ROLE}'
)
SELECT (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_auth_members AS membership, subscriber
         WHERE membership.roleid = subscriber.oid
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_namespace AS namespace, subscriber
         WHERE namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND pg_catalog.has_schema_privilege(subscriber.oid, namespace.oid, 'CREATE')
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN subscriber
         WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S')
           AND namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND (
             pg_catalog.has_table_privilege(subscriber.oid, relation.oid, 'INSERT')
             OR pg_catalog.has_table_privilege(subscriber.oid, relation.oid, 'UPDATE')
             OR pg_catalog.has_table_privilege(subscriber.oid, relation.oid, 'DELETE')
             OR pg_catalog.has_table_privilege(subscriber.oid, relation.oid, 'TRUNCATE')
             OR pg_catalog.has_table_privilege(subscriber.oid, relation.oid, 'REFERENCES')
             OR pg_catalog.has_table_privilege(subscriber.oid, relation.oid, 'TRIGGER')
           )
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_shdepend AS dependency, subscriber
         WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
           AND dependency.refobjid = subscriber.oid
           AND dependency.deptype = 'o'
           AND NOT (
             dependency.classid = 'pg_catalog.pg_subscription'::pg_catalog.regclass
             AND EXISTS (
               SELECT 1 FROM pg_catalog.pg_subscription AS subscription
               WHERE subscription.oid = dependency.objid
                 AND subscription.subname = '${MIGRATION_SUBSCRIPTION_NAME}'
                 AND subscription.subowner = subscriber.oid
                 AND subscription.subenabled
             )
           )
       ))::text
FROM subscriber;")"
      [[ "$subscriber_boundary_contract" == 'true|true|true|true' ]] ||
        blocker "subscriber owner has an incoming role edge, schema CREATE/DML, or ownership outside the exact active subscription"

      subscriber_schema_usage_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    WHERE relation.relnamespace = namespace.oid
      AND relation.relkind IN ('r', 'p')
      AND relation.relpersistence = 'p'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
        WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND extension_dependency.objid = relation.oid
          AND extension_dependency.deptype = 'e'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS subscriber
    CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
    WHERE subscriber.rolname = '${MIGRATION_SUBSCRIBER_ROLE}'
      AND privilege.grantee = subscriber.oid
    GROUP BY subscriber.oid
    HAVING count(*) = 1
       AND pg_catalog.bool_and(
         privilege.privilege_type = 'USAGE'
         AND NOT privilege.is_grantable
       )
  );")"
      [[ "$subscriber_schema_usage_blockers" == '0' ]] ||
        blocker "subscriber owner lacks USAGE on $subscriber_schema_usage_blockers application schema(s) required to register publication tables"

      subscriber_schema_acl_extras="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_namespace AS namespace
JOIN pg_catalog.pg_roles AS subscriber
  ON subscriber.rolname = '${MIGRATION_SUBSCRIBER_ROLE}'
CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
WHERE privilege.grantee = subscriber.oid
  AND NOT (
    privilege.privilege_type = 'USAGE'
    AND NOT privilege.is_grantable
    AND namespace.nspname IN (${included_schemas_sql})
    AND namespace.nspname NOT IN (${excluded_schemas_sql})
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      WHERE relation.relnamespace = namespace.oid
        AND relation.relkind IN ('r', 'p')
        AND relation.relpersistence = 'p'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
          WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND extension_dependency.objid = relation.oid
            AND extension_dependency.deptype = 'e'
        )
    )
  );")"
      [[ "$subscriber_schema_acl_extras" == '0' ]] ||
        blocker "subscriber owner has $subscriber_schema_acl_extras direct schema ACL(s) outside exact non-grantable publication-schema USAGE"
    fi

    wrongly_owned_relations="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p', 'S', 'v', 'm')
  AND namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND pg_catalog.pg_get_userbyid(relation.relowner) <> '${MIGRATION_OWNER_ROLE}'
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$wrongly_owned_relations" == '0' ]] ||
      blocker "$wrongly_owned_relations target relation(s) are not owned by $MIGRATION_OWNER_ROLE"

    wrongly_owned_schemas="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (${included_schemas_sql})
  AND pg_catalog.pg_get_userbyid(namespace.nspowner) <> '${MIGRATION_OWNER_ROLE}';")"
    [[ "$wrongly_owned_schemas" == '0' ]] ||
      blocker "$wrongly_owned_schemas target application schema(s) are not owned by $MIGRATION_OWNER_ROLE"

    wrongly_owned_functions="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_proc AS procedure
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND pg_catalog.pg_get_userbyid(procedure.proowner) <> '${MIGRATION_OWNER_ROLE}'
  AND procedure.oid NOT IN (
    coalesce(pg_catalog.to_regprocedure('ops.board_snapshot_cluster_identity()'), 0::pg_catalog.oid),
    coalesce(pg_catalog.to_regprocedure('ops.acquire_board_snapshot_fence(integer)'), 0::pg_catalog.oid)
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$wrongly_owned_functions" == '0' ]] ||
      blocker "$wrongly_owned_functions target application function(s) are not owned by $MIGRATION_OWNER_ROLE"

    wrongly_owned_types="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_type AS type
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type.typnamespace
WHERE namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND (
    type.typrelid = 0
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS composite_relation
      WHERE composite_relation.oid = type.typrelid
        AND composite_relation.relkind = 'c'
    )
  )
  AND type.typtype IN ('c', 'd', 'e', 'm', 'r')
  AND pg_catalog.pg_get_userbyid(type.typowner) <> '${MIGRATION_OWNER_ROLE}'
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
      AND extension_dependency.objid = type.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$wrongly_owned_types" == '0' ]] ||
      blocker "$wrongly_owned_types target user-defined type(s) are not owned by $MIGRATION_OWNER_ROLE"

    security_definer_owner_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_proc AS procedure
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
WHERE namespace.nspname IN (${included_schemas_sql})
  AND namespace.nspname NOT IN (${excluded_schemas_sql})
  AND procedure.prosecdef
  AND (
    owner.rolsuper
    OR owner.rolname <>
      CASE
        WHEN procedure.oid IN (
          coalesce(pg_catalog.to_regprocedure('ops.board_snapshot_cluster_identity()'), 0::pg_catalog.oid),
          coalesce(pg_catalog.to_regprocedure('ops.acquire_board_snapshot_fence(integer)'), 0::pg_catalog.oid)
        ) THEN '${MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE}'
        ELSE '${MIGRATION_OWNER_ROLE}'
      END
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$security_definer_owner_blockers" == '0' ]] ||
      blocker "$security_definer_owner_blockers SECURITY DEFINER function(s) have the wrong or a superuser owner"

    runtime_schema_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (${runtime_schemas_sql})
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS runtime_role
    CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
    WHERE runtime_role.rolname = '${MIGRATION_RUNTIME_ROLE}'
      AND privilege.grantee = runtime_role.oid
    GROUP BY runtime_role.oid
    HAVING count(*) = 1
       AND pg_catalog.bool_and(
         privilege.privilege_type = 'USAGE'
         AND NOT privilege.is_grantable
       )
  );")"
    [[ "$runtime_schema_blockers" == '0' ]] ||
      blocker "runtime role lacks USAGE on $runtime_schema_blockers required schema(s)"

    runtime_schema_create_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (${runtime_schemas_sql})
  AND pg_catalog.has_schema_privilege(
    (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_RUNTIME_ROLE}'),
    namespace.oid,
    'CREATE'
  );")"
    [[ "$runtime_schema_create_blockers" == '0' ]] ||
      blocker "runtime role has CREATE on $runtime_schema_create_blockers application schema(s); DDL belongs to the migrator/owner boundary"

    runtime_table_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND relation.relpersistence = 'p'
  AND namespace.nspname IN (${runtime_schemas_sql})
  AND NOT (
    relation.relname = '__drizzle_migrations'
    AND namespace.nspname IN ('public', 'drizzle')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS runtime_role
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
    WHERE runtime_role.rolname = '${MIGRATION_RUNTIME_ROLE}'
      AND privilege.grantee = runtime_role.oid
    GROUP BY runtime_role.oid
    HAVING count(*) = 4
       AND count(*) FILTER (
         WHERE privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
           AND NOT privilege.is_grantable
       ) = 4
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$runtime_table_blockers" == '0' ]] ||
      blocker "runtime role lacks exact direct non-grantable CRUD ACLs on $runtime_table_blockers required table(s)"

    runtime_ledger_acl_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_roles AS runtime_role ON runtime_role.rolname = '${MIGRATION_RUNTIME_ROLE}'
WHERE relation.relkind IN ('r', 'p')
  AND relation.relname = '__drizzle_migrations'
  AND namespace.nspname IN ('public', 'drizzle')
  AND (
    pg_catalog.has_table_privilege(runtime_role.oid, relation.oid, 'SELECT')
    OR pg_catalog.has_table_privilege(runtime_role.oid, relation.oid, 'INSERT')
    OR pg_catalog.has_table_privilege(runtime_role.oid, relation.oid, 'UPDATE')
    OR pg_catalog.has_table_privilege(runtime_role.oid, relation.oid, 'DELETE')
    OR pg_catalog.has_table_privilege(runtime_role.oid, relation.oid, 'TRUNCATE')
    OR EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(
        coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS privilege
      WHERE privilege.grantee = 0
        AND privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      WHERE attribute.attrelid = relation.oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND privilege.grantee IN (0, runtime_role.oid)
    )
  );")"
    [[ "$runtime_ledger_acl_blockers" == '0' ]] ||
      blocker "runtime/PUBLIC has CRUD or TRUNCATE on $runtime_ledger_acl_blockers Drizzle ledger(s)"

    runtime_view_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('v', 'm')
  AND namespace.nspname IN (${runtime_schemas_sql})
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS runtime_role
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
    WHERE runtime_role.rolname = '${MIGRATION_RUNTIME_ROLE}'
      AND privilege.grantee = runtime_role.oid
    GROUP BY runtime_role.oid
    HAVING count(*) = 1
       AND bool_and(privilege.privilege_type = 'SELECT' AND NOT privilege.is_grantable)
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$runtime_view_blockers" == '0' ]] ||
      blocker "runtime role lacks an exact direct non-grantable SELECT ACL on $runtime_view_blockers required view(s)"

    runtime_sequence_blockers="$(scalar "$TARGET_DATABASE_URL" "
WITH application_sequences AS MATERIALIZED (
  SELECT sequence.oid
  FROM pg_catalog.pg_class AS sequence
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
  WHERE sequence.relkind = 'S'
    AND sequence.relpersistence = 'p'
    AND namespace.nspname IN (${runtime_schemas_sql})
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_depend AS ownership
      JOIN pg_catalog.pg_class AS owner_table ON owner_table.oid = ownership.refobjid
      JOIN pg_catalog.pg_namespace AS owner_namespace ON owner_namespace.oid = owner_table.relnamespace
      WHERE ownership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND ownership.objid = sequence.oid
        AND ownership.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND ownership.deptype IN ('a', 'i')
        AND ownership.refobjsubid > 0
        AND owner_table.relname = '__drizzle_migrations'
        AND owner_namespace.nspname IN ('public', 'drizzle')
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
      WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND extension_dependency.objid = sequence.oid
        AND extension_dependency.deptype = 'e'
    )
)
SELECT count(*)
FROM application_sequences AS sequence
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles AS runtime_role
  JOIN pg_catalog.pg_class AS sequence_acl ON sequence_acl.oid = sequence.oid
  CROSS JOIN LATERAL pg_catalog.aclexplode(sequence_acl.relacl) AS privilege
  WHERE runtime_role.rolname = '${MIGRATION_RUNTIME_ROLE}'
    AND privilege.grantee = runtime_role.oid
  GROUP BY runtime_role.oid
  HAVING count(*) = 1
     AND bool_and(privilege.privilege_type = 'USAGE' AND NOT privilege.is_grantable)
);")"
    [[ "$runtime_sequence_blockers" == '0' ]] ||
      blocker "runtime role lacks USAGE on $runtime_sequence_blockers required sequence(s)"

    runtime_ledger_sequence_acl_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_class AS sequence
JOIN pg_catalog.pg_roles AS runtime_role ON runtime_role.rolname = '${MIGRATION_RUNTIME_ROLE}'
JOIN pg_catalog.pg_depend AS ownership
  ON ownership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
 AND ownership.objid = sequence.oid
 AND ownership.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
 AND ownership.deptype IN ('a', 'i')
 AND ownership.refobjsubid > 0
JOIN pg_catalog.pg_class AS ledger ON ledger.oid = ownership.refobjid
JOIN pg_catalog.pg_namespace AS ledger_namespace ON ledger_namespace.oid = ledger.relnamespace
WHERE sequence.relkind = 'S'
  AND ledger.relname = '__drizzle_migrations'
  AND ledger_namespace.nspname IN ('public', 'drizzle')
  AND (
    pg_catalog.has_sequence_privilege(runtime_role.oid, sequence.oid, 'USAGE')
    OR pg_catalog.has_sequence_privilege(runtime_role.oid, sequence.oid, 'SELECT')
    OR pg_catalog.has_sequence_privilege(runtime_role.oid, sequence.oid, 'UPDATE')
    OR EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(
        coalesce(sequence.relacl, pg_catalog.acldefault('S', sequence.relowner))
      ) AS privilege
      WHERE privilege.grantee = 0
        AND privilege.privilege_type IN ('USAGE', 'SELECT', 'UPDATE')
    )
  );")"
    [[ "$runtime_ledger_sequence_acl_blockers" == '0' ]] ||
      blocker "runtime/PUBLIC has sequence privileges on $runtime_ledger_sequence_acl_blockers Drizzle ledger sequence(s)"

    runtime_function_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_proc AS procedure
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname IN (${runtime_schemas_sql})
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS runtime_role
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
    WHERE runtime_role.rolname = '${MIGRATION_RUNTIME_ROLE}'
      AND privilege.grantee = runtime_role.oid
    GROUP BY runtime_role.oid
    HAVING count(*) = 1
       AND bool_and(privilege.privilege_type = 'EXECUTE' AND NOT privilege.is_grantable)
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$runtime_function_blockers" == '0' ]] ||
      blocker "runtime role lacks an exact direct non-grantable EXECUTE ACL on $runtime_function_blockers required function(s)"

    public_function_execute_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_proc AS procedure
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname IN (${runtime_schemas_sql})
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS privilege
    WHERE privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND extension_dependency.objid = procedure.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$public_function_execute_blockers" == '0' ]] ||
      blocker "PUBLIC can execute $public_function_execute_blockers non-extension application function(s)"

    runtime_type_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_type AS type_row
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
WHERE namespace.nspname IN (${runtime_schemas_sql})
  AND (
    type_row.typrelid = 0
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS composite_relation
      WHERE composite_relation.oid = type_row.typrelid
        AND composite_relation.relkind = 'c'
    )
  )
  -- Multiranges inherit their range ACL and reject direct GRANT.
  AND type_row.typtype IN ('c', 'd', 'e', 'r')
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS runtime_role
    CROSS JOIN LATERAL pg_catalog.aclexplode(type_row.typacl) AS privilege
    WHERE runtime_role.rolname = '${MIGRATION_RUNTIME_ROLE}'
      AND privilege.grantee = runtime_role.oid
    GROUP BY runtime_role.oid
    HAVING count(*) = 1
       AND bool_and(privilege.privilege_type = 'USAGE' AND NOT privilege.is_grantable)
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
      AND extension_dependency.objid = type_row.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$runtime_type_blockers" == '0' ]] ||
      blocker "runtime role lacks an exact direct non-grantable USAGE ACL on $runtime_type_blockers required user-defined type(s)"

    public_object_acl_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT (
         SELECT count(*)
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           coalesce(relation.relacl, pg_catalog.acldefault(
             CASE WHEN relation.relkind = 'S' THEN 'S'::\"char\" ELSE 'r'::\"char\" END,
             relation.relowner
           ))
         ) AS privilege
         WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S')
           AND namespace.nspname IN (${runtime_schemas_sql})
           AND privilege.grantee = 0
           AND NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_depend AS dependency
             WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
               AND dependency.objid = relation.oid AND dependency.deptype = 'e'
           )
       ) + (
         SELECT count(*)
         FROM pg_catalog.pg_type AS type_row
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           coalesce(type_row.typacl, pg_catalog.acldefault('T', type_row.typowner))
         ) AS privilege
         WHERE type_row.typtype IN ('c', 'd', 'e', 'r')
           AND (type_row.typrelid = 0 OR EXISTS (
             SELECT 1 FROM pg_catalog.pg_class AS composite_relation
             WHERE composite_relation.oid = type_row.typrelid
               AND composite_relation.relkind = 'c'
           ))
           AND namespace.nspname IN (${runtime_schemas_sql})
           AND privilege.grantee = 0
           AND NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_depend AS dependency
             WHERE dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
               AND dependency.objid = type_row.oid AND dependency.deptype = 'e'
           )
       );")"
    [[ "$public_object_acl_blockers" == '0' ]] ||
      blocker "PUBLIC retains $public_object_acl_blockers relation/sequence/type privilege row(s) in runtime schemas"

    default_privilege_blockers="$(scalar "$TARGET_DATABASE_URL" "
WITH expected_privilege(object_type, privilege_type) AS (
  VALUES
    ('f', 'EXECUTE'),
    ('T', 'USAGE')
), runtime_schema AS (
  SELECT oid
  FROM pg_catalog.pg_namespace
  WHERE nspname IN (${runtime_schemas_sql})
), owner_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_OWNER_ROLE}'
), runtime_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_RUNTIME_ROLE}'
)
SELECT count(*)
FROM runtime_schema
CROSS JOIN expected_privilege
CROSS JOIN owner_role
CROSS JOIN runtime_role
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_default_acl AS default_acl
  CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS acl
  WHERE default_acl.defaclrole = owner_role.oid
    AND default_acl.defaclnamespace = runtime_schema.oid
    AND default_acl.defaclobjtype::text = expected_privilege.object_type
    AND acl.grantee = runtime_role.oid
    AND acl.privilege_type = expected_privilege.privilege_type
    AND NOT acl.is_grantable
);")"
    [[ "$default_privilege_blockers" == '0' ]] ||
      blocker "$default_privilege_blockers required owner→runtime routine/type default privilege(s) are missing"

    default_privilege_extra_blockers="$(scalar "$TARGET_DATABASE_URL" "
WITH runtime_schema AS (
  SELECT oid
  FROM pg_catalog.pg_namespace
  WHERE nspname IN (${runtime_schemas_sql})
), owner_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_OWNER_ROLE}'
), runtime_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_RUNTIME_ROLE}'
)
SELECT count(*)
FROM pg_catalog.pg_default_acl AS default_acl
CROSS JOIN owner_role
CROSS JOIN runtime_role
CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS acl
WHERE default_acl.defaclrole = owner_role.oid
  AND acl.grantee = runtime_role.oid
  AND NOT (
    default_acl.defaclnamespace IN (SELECT oid FROM runtime_schema)
    AND NOT acl.is_grantable
    AND (
      (default_acl.defaclobjtype = 'f' AND acl.privilege_type = 'EXECUTE')
      OR (default_acl.defaclobjtype = 'T' AND acl.privilege_type = 'USAGE')
    )
  );")"
    [[ "$default_privilege_extra_blockers" == '0' ]] ||
      blocker "$default_privilege_extra_blockers unexpected or grantable owner→runtime default privilege(s) exist"

    public_routine_type_default_blockers="$(scalar "$TARGET_DATABASE_URL" "
WITH runtime_schema AS (
  SELECT oid FROM pg_catalog.pg_namespace WHERE nspname IN (${runtime_schemas_sql})
), owner_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_OWNER_ROLE}'
), expected_default(object_type, privilege_type) AS (
  VALUES ('f'::\"char\", 'EXECUTE'::text), ('T'::\"char\", 'USAGE'::text)
)
SELECT count(*)
FROM expected_default
CROSS JOIN owner_role
WHERE EXISTS (
  SELECT 1
  FROM LATERAL pg_catalog.aclexplode(coalesce(
    (
      SELECT default_acl.defaclacl
      FROM pg_catalog.pg_default_acl AS default_acl
      WHERE default_acl.defaclrole = owner_role.oid
        AND default_acl.defaclnamespace = 0
        AND default_acl.defaclobjtype = expected_default.object_type
    ),
    pg_catalog.acldefault(expected_default.object_type, owner_role.oid)
  )) AS acl
  WHERE acl.grantee = 0
    AND acl.privilege_type = expected_default.privilege_type
)
OR EXISTS (
  SELECT 1
  FROM pg_catalog.pg_default_acl AS default_acl
  JOIN runtime_schema ON runtime_schema.oid = default_acl.defaclnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS acl
  WHERE default_acl.defaclrole = owner_role.oid
    AND default_acl.defaclobjtype = expected_default.object_type
    AND acl.grantee = 0
    AND acl.privilege_type = expected_default.privilege_type
);")"
    [[ "$public_routine_type_default_blockers" == '0' ]] ||
      blocker "owner-wide defaults still grant PUBLIC routine EXECUTE or type USAGE in $public_routine_type_default_blockers object class(es)"

    source_runtime_role_exists="$(scalar "$SOURCE_DATABASE_URL" "
SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_RUNTIME_ROLE}';")"
    if [[ "$source_runtime_role_exists" != '1' ]]; then
      blocker "source must contain the exact runtime role before ACL transition verification"
    else
      source_runtime_acl_file="$audit_directory/source-runtime-acl"
      target_runtime_acl_file="$audit_directory/target-runtime-acl"
      runtime_acl_manifest "$SOURCE_DATABASE_URL" "$MIGRATION_RUNTIME_ROLE" >"$source_runtime_acl_file"
      runtime_acl_manifest "$TARGET_DATABASE_URL" "$MIGRATION_RUNTIME_ROLE" >"$target_runtime_acl_file"
      compare_manifests 'runtime/PUBLIC direct ACL policy' "$source_runtime_acl_file" "$target_runtime_acl_file"
    fi

    replication_dml_blockers="$(scalar "$TARGET_DATABASE_URL" "
SELECT count(*)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND relation.relpersistence = 'p'
  AND namespace.nspname IN (${included_schemas_sql})
  AND (
    pg_catalog.has_table_privilege((SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_REPLICATION_ROLE}'), relation.oid, 'SELECT')
    OR pg_catalog.has_table_privilege((SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_REPLICATION_ROLE}'), relation.oid, 'INSERT')
    OR pg_catalog.has_table_privilege((SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_REPLICATION_ROLE}'), relation.oid, 'UPDATE')
    OR pg_catalog.has_table_privilege((SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATION_REPLICATION_ROLE}'), relation.oid, 'DELETE')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND extension_dependency.objid = relation.oid
      AND extension_dependency.deptype = 'e'
  );")"
    [[ "$replication_dml_blockers" == '0' ]] ||
      blocker "replication role has effective application DML privileges on $replication_dml_blockers table(s)"
  fi
fi

printf '\nAudit result: %s blocker(s).\n' "$blocker_count"
if [[ "$blocker_count" -ne 0 ]]; then
  exit 1
fi
