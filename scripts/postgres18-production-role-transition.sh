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
OWNER_ROLE="${OWNER_ROLE:-boardsesh_owner}"
RUNTIME_ROLE="${RUNTIME_ROLE:-boardsesh_runtime}"
MIGRATOR_ROLE="${MIGRATOR_ROLE:-boardsesh_migrator}"
FENCE_OWNER_ROLE="${FENCE_OWNER_ROLE:-boardsesh_snapshot_fence_owner}"
INCLUDE_SCHEMAS="${INCLUDE_SCHEMAS:-public drizzle}"
ADMIN_DATABASE_URL="${ADMIN_DATABASE_URL:-}"
MIGRATOR_DATABASE_URL="${MIGRATOR_DATABASE_URL:-}"
RUNTIME_DATABASE_URL="${RUNTIME_DATABASE_URL:-}"

# prepare-source-acls and transfer-ownership both run against a live primary:
# every GRANT/REVOKE and every ALTER ... OWNER TO takes ACCESS EXCLUSIVE, and
# `--single-transaction` holds each of those locks until COMMIT. Without a bound
# one long-running reader parks the transaction on a lock queue and every later
# query on that relation queues behind it, so the whole site stalls with no
# abort path. lock_timeout caps the wait for any single lock, statement_timeout
# caps a runaway statement, and psql's ON_ERROR_STOP + --single-transaction turn
# either timeout into a full ROLLBACK, which keeps each attempt all-or-nothing.
DDL_LOCK_TIMEOUT_MS="${DDL_LOCK_TIMEOUT_MS:-3000}"
DDL_STATEMENT_TIMEOUT_MS="${DDL_STATEMENT_TIMEOUT_MS:-60000}"
DDL_LOCK_ATTEMPTS="${DDL_LOCK_ATTEMPTS:-5}"
DDL_LOCK_RETRY_DELAY_SECONDS="${DDL_LOCK_RETRY_DELAY_SECONDS:-15}"
# Neither timeout above bounds how long the transaction holds what it has already
# taken. transfer-ownership ALTERs every relation, sequence, view, function and
# type in INCLUDE_SCHEMAS in one transaction - 150+ objects for this schema - and
# each ALTER may wait up to lock_timeout while ACCESS EXCLUSIVE is retained on
# every object altered so far. A primary with no single slow blocker but steady
# sub-second readers can therefore hold site-wide exclusive locks for minutes on
# the success path, and nothing in PG16 aborts that (transaction_timeout is PG17).
# So bound the hold from outside: a watchdog cancels the DDL backend once the
# transaction has been running this long. The cancel rolls the whole transaction
# back, exactly like a timeout, so the retry stays all-or-nothing.
DDL_MAX_LOCK_HOLD_SECONDS="${DDL_MAX_LOCK_HOLD_SECONDS:-60}"
# A transaction older than this already holds locks the DDL will collide with,
# and lock_timeout only bounds the wait per relation, not per transaction. Refuse
# up front instead of letting the operator discover it through a stalled site.
MAX_BLOCKING_TRANSACTION_SECONDS="${MAX_BLOCKING_TRANSACTION_SECONDS:-60}"

CREDENTIALS_DIRECTORY=''
DDL_WATCHDOG_PID=''

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_identifier() {
  local label="$1" identifier="$2"
  [[ "$identifier" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    fail "$label must be a simple PostgreSQL identifier"
}

require_non_negative_integer() {
  local label="$1" number="$2"
  [[ "$number" =~ ^[0-9]+$ ]] || fail "$label must be a non-negative integer"
}

schema_csv() {
  local schema joined='' seen=' '
  for schema in $INCLUDE_SCHEMAS; do
    require_identifier INCLUDE_SCHEMAS "$schema"
    [[ "$seen" != *" $schema "* ]] || fail "INCLUDE_SCHEMAS contains duplicate schema $schema"
    seen+="$schema "
    joined+="${joined:+, }$schema"
  done
  [[ -n "$joined" ]] || fail 'INCLUDE_SCHEMAS must not be empty'
  printf '%s' "$joined"
}

assert_schema_manifest() {
  local connection_name="$1" schemas contract
  schemas="$(schema_csv)"
  contract="$(run_connection "$connection_name" -Atq -v schemas="$schemas" <<'SQL'
WITH requested(schema_name) AS (
  SELECT unnest(string_to_array(:'schemas', ', '))
)
SELECT count(*) = (SELECT count(*) FROM requested)
       AND count(*) = count(DISTINCT namespace.oid)
FROM requested
JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = requested.schema_name;
SQL
)"
  [[ "$contract" == 't' ]] ||
    fail 'every INCLUDE_SCHEMAS entry must exist exactly once before role transition'
}

prepare_connections() {
  local credentials_directory="$1"
  if [[ -n "$ADMIN_DATABASE_URL" ]]; then
    boardsesh_prepare_libpq_connection ADMIN "$ADMIN_DATABASE_URL" "$credentials_directory"
  fi
  if [[ -n "$MIGRATOR_DATABASE_URL" ]]; then
    boardsesh_prepare_libpq_connection MIGRATOR "$MIGRATOR_DATABASE_URL" "$credentials_directory"
  fi
  if [[ -n "$RUNTIME_DATABASE_URL" ]]; then
    boardsesh_prepare_libpq_connection RUNTIME "$RUNTIME_DATABASE_URL" "$credentials_directory"
  fi
  ADMIN_DATABASE_URL='' MIGRATOR_DATABASE_URL='' RUNTIME_DATABASE_URL=''
  unset DATABASE_URL POSTGRES_URL PGPASSWORD
}

run_connection() {
  local name="$1"
  shift
  BOARDSESH_LIBPQ_CONNECT_TIMEOUT=10 \
    boardsesh_run_libpq_connection "$name" psql -X -v ON_ERROR_STOP=1 "$@"
}

assert_no_long_running_transactions() {
  local name="$1" oldest_transaction_age
  oldest_transaction_age="$(run_connection "$name" -Atq -c "
SELECT coalesce(max(floor(extract(epoch FROM now() - activity.xact_start))), -1)::bigint
FROM pg_catalog.pg_stat_activity AS activity
WHERE activity.datname = current_database()
  AND activity.pid <> pg_catalog.pg_backend_pid()
  AND activity.backend_type = 'client backend'
  AND activity.xact_start IS NOT NULL;")"
  [[ "$oldest_transaction_age" =~ ^-?[0-9]+$ ]] ||
    fail 'could not read pg_stat_activity to bound the DDL lock window'
  [[ "$oldest_transaction_age" -le "$MAX_BLOCKING_TRANSACTION_SECONDS" ]] ||
    fail "a client transaction has been open for ${oldest_transaction_age}s (limit ${MAX_BLOCKING_TRANSACTION_SECONDS}s); every relation this command rewrites needs ACCESS EXCLUSIVE, so run it in a low-traffic window after clearing long-running transactions from pg_stat_activity"
}

# Wall-clock ceiling on one DDL attempt. Waits out the grace period, then cancels
# the tagged DDL backend from a second session until one cancel actually lands
# (the DDL session may still be connecting when the deadline passes). Writes the
# marker only once a backend was cancelled, so the caller can name the bound that
# fired. pg_cancel_backend needs no extra privilege here: both sessions are the
# same admin role.
cancel_stalled_ddl_session() {
  local ddl_application_name="$1" marker_file="$2"
  local cancel_attempt=0 cancelled
  sleep "$DDL_MAX_LOCK_HOLD_SECONDS"
  while [[ "$cancel_attempt" -lt 30 ]]; do
    cancelled="$(run_connection ADMIN -Atq -v ddl_application_name="$ddl_application_name" <<'SQL' 2>/dev/null || true
SELECT pg_catalog.pg_cancel_backend(activity.pid)
FROM pg_catalog.pg_stat_activity AS activity
WHERE activity.datname = current_database()
  AND activity.application_name = :'ddl_application_name'
  AND activity.pid <> pg_catalog.pg_backend_pid();
SQL
)"
    if [[ -n "$cancelled" ]]; then
      : >"$marker_file"
      return 0
    fi
    cancel_attempt=$((cancel_attempt + 1))
    sleep 1
  done
}

# Runs one all-or-nothing psql transaction under lock_timeout/statement_timeout
# plus the DDL_MAX_LOCK_HOLD_SECONDS wall-clock ceiling. A timed-out or cancelled
# attempt has already rolled back in full, so releasing the lock queue and trying
# again later is both safe and far cheaper for live traffic than letting one
# attempt block indefinitely. Anything that is not a timeout or a cancel fails
# immediately: that is a real error, not contention.
run_bounded_ddl_transaction() {
  local label="$1" statements="$2"
  shift 2
  local attempt=1 status transcript ddl_application_name watchdog_fired blocked_reason
  local watchdog_marker="$CREDENTIALS_DIRECTORY/ddl-watchdog-fired"
  while :; do
    assert_no_long_running_transactions ADMIN
    status=0
    rm -f "$watchdog_marker"
    # The tag is set inside the transaction itself, so it is live from the first
    # lock wait onwards and is unique to this process and attempt.
    ddl_application_name="boardsesh-ddl-${label}-$$-${attempt}"
    cancel_stalled_ddl_session "$ddl_application_name" "$watchdog_marker" &
    # $! is this shell's last background pid; the command substitutions in this
    # loop are children, not this assignment's scope.
    # shellcheck disable=SC2031
    DDL_WATCHDOG_PID=$!
    transcript="$(
      BOARDSESH_LIBPQ_EXTRA_OPTIONS="-c lock_timeout=${DDL_LOCK_TIMEOUT_MS} -c statement_timeout=${DDL_STATEMENT_TIMEOUT_MS}" \
        run_connection ADMIN --single-transaction -v VERBOSITY=verbose "$@" \
        <<<"SET application_name = '${ddl_application_name}';
$statements" 2>&1
    )" || status=$?
    kill "$DDL_WATCHDOG_PID" 2>/dev/null || true
    wait "$DDL_WATCHDOG_PID" 2>/dev/null || true
    DDL_WATCHDOG_PID=''
    watchdog_fired=false
    if [[ -f "$watchdog_marker" ]]; then
      watchdog_fired=true
      rm -f "$watchdog_marker"
    fi
    [[ -z "$transcript" ]] || printf '%s\n' "$transcript"
    if [[ "$status" -eq 0 ]]; then
      return 0
    fi
    # 55P03 is lock_timeout; 57014 covers both statement_timeout and the
    # watchdog's pg_cancel_backend. VERBOSITY=verbose puts the SQLSTATE in the
    # message, so this match does not depend on the server's lc_messages.
    if [[ ! "$transcript" =~ ERROR:[[:space:]]+(55P03|57014) ]]; then
      fail "$label failed and its single transaction rolled back; nothing was changed"
    fi
    if [[ "$watchdog_fired" == true ]]; then
      blocked_reason="held its locks past the ${DDL_MAX_LOCK_HOLD_SECONDS}s ceiling and was cancelled"
    else
      blocked_reason='timed out on a lock'
    fi
    if [[ "$attempt" -ge "$DDL_LOCK_ATTEMPTS" ]]; then
      fail "$label gave up after $DDL_LOCK_ATTEMPTS attempts blocked on locks (lock_timeout=${DDL_LOCK_TIMEOUT_MS}ms, hold ceiling ${DDL_MAX_LOCK_HOLD_SECONDS}s); every attempt rolled back in full, so the database is untouched. Find the blocking sessions in pg_stat_activity/pg_locks, clear them, and re-run this exact command in a low-traffic window."
    fi
    printf '%s attempt %s of %s %s and rolled back; retrying in %ss.\n' \
      "$label" "$attempt" "$DDL_LOCK_ATTEMPTS" "$blocked_reason" "$DDL_LOCK_RETRY_DELAY_SECONDS" >&2
    sleep "$DDL_LOCK_RETRY_DELAY_SECONDS"
    attempt=$((attempt + 1))
  done
}

assert_database() {
  local name="$1" database_name
  database_name="$(run_connection "$name" -Atq -c 'SELECT current_database();')"
  [[ "$database_name" == "$EXPECTED_DATABASE" ]] ||
    fail "$name connects to $database_name; expected canonical database $EXPECTED_DATABASE"
}

assert_role_contract() {
  local name="$1" role="$2" expected="$3" contract
  require_identifier role "$role"
  contract="$(run_connection "$name" -Atq -c "
SELECT rolcanlogin::text || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' ||
       rolcreaterole::text || '|' || rolinherit::text || '|' || rolreplication::text || '|' ||
       rolbypassrls::text
FROM pg_catalog.pg_roles WHERE rolname = '${role}';")"
  [[ "$contract" == "$expected" ]] || fail "$role does not match its exact restricted role contract"
}

assert_owner_database_create() {
  local name="$1" contract
  contract="$(run_connection "$name" -Atq -c "
SELECT count(*) = 1
  AND pg_catalog.bool_and(
    privilege.privilege_type = 'CREATE'
    AND NOT privilege.is_grantable
  )
FROM pg_catalog.pg_database AS database
JOIN pg_catalog.pg_roles AS owner_role ON owner_role.rolname = '${OWNER_ROLE}'
CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
WHERE database.datname = current_database()
  AND database.datdba <> owner_role.oid
  AND privilege.grantee = owner_role.oid;")"
  [[ "$contract" == 't' ]] ||
    fail "$OWNER_ROLE must have exactly one direct non-grantable database CREATE ACL"
}

assert_login_has_no_ddl_path() {
  local name="$1" role="$2" contract
  require_identifier role "$role"
  contract="$(run_connection "$name" -Atq -c "
WITH login_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${role}'
)
SELECT (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_database AS database, login_role
         WHERE database.datdba = login_role.oid
       ))::text || '|' ||
       (NOT pg_catalog.has_database_privilege(
         (SELECT oid FROM login_role), current_database(), 'CREATE'
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_namespace AS namespace, login_role
         WHERE namespace.nspname <> 'information_schema'
           AND namespace.nspname !~ '^pg_'
           AND pg_catalog.has_schema_privilege(login_role.oid, namespace.oid, 'CREATE')
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_shdepend AS dependency, login_role
         WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
           AND dependency.refobjid = login_role.oid
           AND dependency.deptype = 'o'
       ))::text;")"
  [[ "$contract" == 'true|true|true|true' ]] ||
    fail "$role must not own database/schema objects or have effective database/application-schema CREATE"
}

verify_fence_owner_contract() {
  local name="$1" contract
  contract="$(run_connection "$name" -Atq -c "
WITH owner_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${OWNER_ROLE}'
), fence_owner AS (
  SELECT * FROM pg_catalog.pg_roles WHERE rolname = '${FENCE_OWNER_ROLE}'
), stats_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'pg_read_all_stats'
), allowed(function_oid) AS (
  VALUES
    ('pg_catalog.pg_control_system()'::pg_catalog.regprocedure),
    ('pg_catalog.pg_control_checkpoint()'::pg_catalog.regprocedure),
    (pg_catalog.to_regprocedure('ops.board_snapshot_cluster_identity()')),
    (pg_catalog.to_regprocedure('ops.acquire_board_snapshot_fence(integer)'))
)
SELECT (NOT fence_owner.rolcanlogin AND NOT fence_owner.rolsuper
          AND NOT fence_owner.rolcreatedb AND NOT fence_owner.rolcreaterole
          AND fence_owner.rolinherit AND NOT fence_owner.rolreplication
          AND NOT fence_owner.rolbypassrls)::text || '|' ||
       (SELECT count(*) = 1 AND pg_catalog.bool_and(
                 membership.roleid = stats_role.oid AND NOT membership.admin_option
                 AND membership.inherit_option AND NOT membership.set_option)
        FROM pg_catalog.pg_auth_members AS membership, stats_role
        WHERE membership.member = fence_owner.oid)::text || '|' ||
       (SELECT count(*) = 1 AND pg_catalog.bool_and(
                 membership.member = owner_role.oid AND NOT membership.admin_option
                 AND NOT membership.inherit_option AND membership.set_option)
        FROM pg_catalog.pg_auth_members AS membership, owner_role
        WHERE membership.roleid = fence_owner.oid)::text || '|' ||
       (SELECT count(*) = 2
        FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = fence_owner.oid
           OR membership.roleid = fence_owner.oid)::text || '|' ||
       (SELECT count(*) = 2 AND pg_catalog.bool_and(
                 direct_count = 1 AND non_grantable_count = 1
                 AND public_execute_count = 0)
        FROM (
          SELECT allowed.function_oid,
                 count(*) FILTER (WHERE privilege.grantee = fence_owner.oid
                   AND privilege.privilege_type = 'EXECUTE') AS direct_count,
                 count(*) FILTER (WHERE privilege.grantee = fence_owner.oid
                   AND privilege.privilege_type = 'EXECUTE'
                   AND NOT privilege.is_grantable) AS non_grantable_count
                 ,count(*) FILTER (WHERE privilege.grantee = 0
                   AND privilege.privilege_type = 'EXECUTE') AS public_execute_count
          FROM allowed
          JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = allowed.function_oid
          LEFT JOIN LATERAL pg_catalog.aclexplode(
            coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
          ) AS privilege ON true
          WHERE allowed.function_oid IN (
            'pg_catalog.pg_control_system()'::pg_catalog.regprocedure,
            'pg_catalog.pg_control_checkpoint()'::pg_catalog.regprocedure)
          GROUP BY allowed.function_oid
        ) AS per_function)::text || '|' ||
       (NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc AS procedure
          CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
          WHERE privilege.grantee = fence_owner.oid
            AND privilege.privilege_type = 'EXECUTE'
            AND NOT EXISTS (SELECT 1 FROM allowed WHERE allowed.function_oid = procedure.oid)
        ))::text || '|' ||
       (NOT pg_catalog.has_database_privilege(fence_owner.oid, current_database(), 'CREATE'))::text || '|' ||
       (NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace AS namespace
          WHERE namespace.nspname <> 'ops'
            AND namespace.nspname <> 'information_schema'
            AND namespace.nspname !~ '^pg_'
            AND pg_catalog.has_schema_privilege(fence_owner.oid, namespace.oid, 'CREATE')
        ))::text || '|' ||
       (NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_database AS database
          CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
          WHERE privilege.grantee = fence_owner.oid
        ))::text || '|' ||
       ((NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace AS namespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
          WHERE privilege.grantee = fence_owner.oid
            AND NOT (
              namespace.nspname = 'ops'
              AND privilege.privilege_type IN ('USAGE', 'CREATE')
              AND NOT privilege.is_grantable
            )
        )) AND (
          SELECT count(*) = CASE WHEN pg_catalog.to_regnamespace('ops') IS NULL THEN 0 ELSE 2 END
                 AND coalesce(pg_catalog.bool_and(
                   privilege.privilege_type IN ('USAGE', 'CREATE') AND NOT privilege.is_grantable
                 ), true)
          FROM pg_catalog.pg_namespace AS namespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
          WHERE namespace.nspname = 'ops' AND privilege.grantee = fence_owner.oid
        ))::text || '|' ||
       (NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_shdepend AS dependency
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
          SELECT 1
          FROM pg_catalog.pg_class AS relation
          CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
          WHERE privilege.grantee = fence_owner.oid
        )) AND (NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_type AS type_row
          CROSS JOIN LATERAL pg_catalog.aclexplode(type_row.typacl) AS privilege
          WHERE privilege.grantee = fence_owner.oid
        )) AND (NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
          WHERE attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND privilege.grantee = fence_owner.oid
        )))::text
FROM fence_owner;")"
  [[ "$contract" == 'true|true|true|true|true|true|true|true|true|true|true|true' ]] ||
    fail "$FENCE_OWNER_ROLE does not match the exact fence-owner role graph, ownership, or relation/type/column ACL boundary (catalog=$contract)"
}

assert_no_direct_memberships() {
  local name="$1" role="$2" contract
  require_identifier role "$role"
  contract="$(run_connection "$name" -Atq -c "
SELECT count(*) = 0
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname = '${role}' OR granted_role.rolname = '${role}';")"
  [[ "$contract" == 't' ]] || fail "$role must have no incoming or outgoing direct role memberships"
}

assert_pretransition_owner_boundary() {
  local name="$1" contract
  contract="$(run_connection "$name" -Atq -c "
WITH owner_role AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${OWNER_ROLE}'
), fence_owner AS (
  SELECT * FROM pg_catalog.pg_roles WHERE rolname = '${FENCE_OWNER_ROLE}'
)
SELECT (NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_database AS database, owner_role
         WHERE database.datdba = owner_role.oid
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
         JOIN owner_role ON owner_role.oid = membership.roleid
         JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
         WHERE member_role.rolname <> '${MIGRATOR_ROLE}'
            OR membership.admin_option OR membership.inherit_option OR NOT membership.set_option
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
         JOIN owner_role ON owner_role.oid = membership.member
         JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
         WHERE granted_role.rolname <> '${FENCE_OWNER_ROLE}'
            OR membership.admin_option OR membership.inherit_option OR NOT membership.set_option
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1
         FROM fence_owner
         WHERE fence_owner.rolcanlogin OR fence_owner.rolsuper
            OR fence_owner.rolcreatedb OR fence_owner.rolcreaterole
            OR NOT fence_owner.rolinherit OR fence_owner.rolreplication
            OR fence_owner.rolbypassrls
       ))::text || '|' ||
       (NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
         JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
         JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
         WHERE (member_role.rolname = '${FENCE_OWNER_ROLE}'
                OR granted_role.rolname = '${FENCE_OWNER_ROLE}')
           AND NOT (
             member_role.rolname = '${FENCE_OWNER_ROLE}'
             AND granted_role.rolname = 'pg_read_all_stats'
             AND NOT membership.admin_option AND membership.inherit_option AND NOT membership.set_option
           )
           AND NOT (
             member_role.rolname = '${OWNER_ROLE}'
             AND granted_role.rolname = '${FENCE_OWNER_ROLE}'
             AND NOT membership.admin_option AND NOT membership.inherit_option AND membership.set_option
           )
       ))::text;")"
  [[ "$contract" == 'true|true|true|true|true' ]] ||
    fail "$OWNER_ROLE/$FENCE_OWNER_ROLE pre-transition ownership and membership boundary is not exact"
}

prepare_source_acl_policy() {
  [[ -n "${BOARDSESH_LIBPQ_ADMIN_ENV_NAMES:-}" ]] || fail 'ADMIN_DATABASE_URL is required'
  assert_database ADMIN
  assert_role_contract ADMIN "$OWNER_ROLE" 'false|false|false|false|true|false|false'
  assert_role_contract ADMIN "$RUNTIME_ROLE" 'true|false|false|false|true|false|false'
  assert_role_contract ADMIN "$MIGRATOR_ROLE" 'true|false|false|false|true|false|false'
  assert_no_direct_memberships ADMIN "$RUNTIME_ROLE"
  assert_login_has_no_ddl_path ADMIN "$RUNTIME_ROLE"
  assert_login_has_no_ddl_path ADMIN "$MIGRATOR_ROLE"
  assert_pretransition_owner_boundary ADMIN
  assert_schema_manifest ADMIN

  local schemas acl_policy_statements
  schemas="$(schema_csv)"
  acl_policy_statements="$(
    cat <<'SQL'
SELECT format('CREATE ROLE %I', :'fence_owner_role')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'fence_owner_role'
)
\gexec
SELECT format(
  'ALTER ROLE %I WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;',
  :'fence_owner_role'
)
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I;', :'expected_database', :'owner_role')
\gexec
SELECT format('GRANT CREATE ON DATABASE %I TO %I;', :'expected_database', :'owner_role')
\gexec
SELECT format('REVOKE %I FROM %I;', granted_role.rolname, :'migrator_role')
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname = :'migrator_role'
ORDER BY granted_role.rolname
\gexec
SELECT format('REVOKE %I FROM %I;', :'migrator_role', member_role.rolname)
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE granted_role.rolname = :'migrator_role'
ORDER BY member_role.rolname
\gexec
SELECT format('GRANT %I TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;',
              :'owner_role', :'migrator_role')
\gexec

SELECT format('REVOKE %I FROM %I;', granted_role.rolname, :'fence_owner_role')
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname = :'fence_owner_role'
ORDER BY granted_role.rolname
\gexec
SELECT format('REVOKE %I FROM %I;', :'fence_owner_role', member_role.rolname)
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE granted_role.rolname = :'fence_owner_role'
ORDER BY member_role.rolname
\gexec
SELECT format('REVOKE %I FROM %I;', granted_role.rolname, :'owner_role')
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname = :'owner_role'
ORDER BY granted_role.rolname
\gexec
SELECT format('GRANT pg_read_all_stats TO %I WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;', :'fence_owner_role')
\gexec
SELECT format('GRANT %I TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;',
              :'fence_owner_role', :'owner_role')
\gexec
SELECT format(
  'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system(), pg_catalog.pg_control_checkpoint() FROM PUBLIC, %I;',
  :'fence_owner_role'
)
\gexec
SELECT format(
  'GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(), pg_catalog.pg_control_checkpoint() TO %I;',
  :'fence_owner_role'
)
\gexec

SELECT format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC; REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I; GRANT USAGE ON SCHEMA %I TO %I;',
              namespace.nspname, namespace.nspname, :'runtime_role',
              namespace.nspname, :'runtime_role')
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
ORDER BY namespace.nspname
\gexec
SELECT format('REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM PUBLIC, %I;',
              attribute.attname, namespace.nspname, relation.relname, :'runtime_role')
FROM pg_catalog.pg_attribute AS attribute
JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
WHERE relation.relkind IN ('r', 'p', 'v', 'm')
  AND namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND privilege.grantee IN (
    0,
    (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = :'runtime_role')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND dependency.objid = relation.oid AND dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname, attribute.attnum
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, %I; GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I;',
              namespace.nspname, relation.relname, :'runtime_role',
              namespace.nspname, relation.relname, :'runtime_role')
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
  AND NOT (
    relation.relname = '__drizzle_migrations'
    AND namespace.nspname IN ('public', 'drizzle')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND dependency.objid = relation.oid AND dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, %I;',
              namespace.nspname, relation.relname, :'runtime_role')
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND relation.relname = '__drizzle_migrations'
  AND namespace.nspname IN ('public', 'drizzle')
ORDER BY namespace.nspname
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, %I; GRANT SELECT ON TABLE %I.%I TO %I;',
              namespace.nspname, relation.relname, :'runtime_role',
              namespace.nspname, relation.relname, :'runtime_role')
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('v', 'm')
  AND namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND dependency.objid = relation.oid AND dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname
\gexec
SELECT format(
         CASE WHEN owner_table.relname = '__drizzle_migrations'
                    AND owner_namespace.nspname IN ('public', 'drizzle')
           THEN 'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM PUBLIC, %I;'
           ELSE 'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM PUBLIC, %I; GRANT USAGE ON SEQUENCE %I.%I TO %I;'
         END,
         namespace.nspname, relation.relname, :'runtime_role',
         namespace.nspname, relation.relname, :'runtime_role')
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_depend AS ownership
  ON ownership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
 AND ownership.objid = relation.oid
 AND ownership.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
 AND ownership.deptype IN ('a', 'i')
 AND ownership.refobjsubid > 0
LEFT JOIN pg_catalog.pg_class AS owner_table ON owner_table.oid = ownership.refobjid
LEFT JOIN pg_catalog.pg_namespace AS owner_namespace ON owner_namespace.oid = owner_table.relnamespace
WHERE relation.relkind = 'S'
  AND namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND dependency.objid = relation.oid AND dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON ROUTINE %s FROM PUBLIC, %I; GRANT EXECUTE ON ROUTINE %s TO %I;',
              procedure.oid::pg_catalog.regprocedure, :'runtime_role',
              procedure.oid::pg_catalog.regprocedure, :'runtime_role')
FROM pg_catalog.pg_proc AS procedure
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, procedure.proname, procedure.oid
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON TYPE %I.%I FROM PUBLIC, %I; GRANT USAGE ON TYPE %I.%I TO %I;',
              namespace.nspname, type_row.typname, :'runtime_role',
              namespace.nspname, type_row.typname, :'runtime_role')
FROM pg_catalog.pg_type AS type_row
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
-- Multiranges inherit the owning range ACL and reject direct GRANT.
WHERE type_row.typtype IN ('c', 'd', 'e', 'r')
  AND (type_row.typrelid = 0 OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS composite_relation
    WHERE composite_relation.oid = type_row.typrelid AND composite_relation.relkind = 'c'
  ))
  AND namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
      AND dependency.objid = type_row.oid AND dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, type_row.typname
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM PUBLIC, %I; ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM PUBLIC, %I; ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON ROUTINES FROM PUBLIC, %I; ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TYPES FROM PUBLIC, %I;',
              :'owner_role', :'runtime_role', :'owner_role', :'runtime_role',
              :'owner_role', :'runtime_role', :'owner_role', :'runtime_role')
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON ROUTINES FROM PUBLIC, %I; ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TYPES FROM PUBLIC, %I;',
              :'owner_role', namespace.nspname, :'runtime_role',
              :'owner_role', namespace.nspname, :'runtime_role')
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
ORDER BY namespace.nspname
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM PUBLIC, %I; ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM PUBLIC, %I;',
              :'owner_role', namespace.nspname, :'runtime_role',
              :'owner_role', namespace.nspname, :'runtime_role')
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
ORDER BY namespace.nspname
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT EXECUTE ON ROUTINES TO %I;',
              :'owner_role', namespace.nspname, :'runtime_role')
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
ORDER BY namespace.nspname
\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE ON TYPES TO %I;',
              :'owner_role', namespace.nspname, :'runtime_role')
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
ORDER BY namespace.nspname
\gexec
\if :inject_late_failure
DO $$ BEGIN RAISE EXCEPTION 'injected late prepare-source-acls failure'; END $$;
\endif
SQL
  )"
  run_bounded_ddl_transaction prepare-source-acls "$acl_policy_statements" \
    -v owner_role="$OWNER_ROLE" \
    -v runtime_role="$RUNTIME_ROLE" \
    -v migrator_role="$MIGRATOR_ROLE" \
    -v fence_owner_role="$FENCE_OWNER_ROLE" \
    -v expected_database="$EXPECTED_DATABASE" \
    -v schemas="$schemas" \
    -v inject_late_failure="${INJECT_LATE_FAILURE:-false}"

  assert_owner_database_create ADMIN
  verify_migrator_edge ADMIN
  assert_role_contract ADMIN "$FENCE_OWNER_ROLE" 'false|false|false|false|true|false|false'
  verify_fence_owner_contract ADMIN
  printf 'Source ACL policy prepared. Rotate the deploy secret to the dedicated migrator URL next.\n'
}

verify_migrator_edge() {
  local connection_name="$1" edge_contract
  edge_contract="$(run_connection "$connection_name" -Atq -c "
WITH owner_role AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${OWNER_ROLE}'),
     migrator_role AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATOR_ROLE}')
SELECT (
         SELECT count(*) FILTER (
                  WHERE membership.roleid = owner_role.oid
                    AND NOT membership.admin_option
                    AND NOT membership.inherit_option
                    AND membership.set_option
                ) = 1 AND count(*) = 1
         FROM pg_catalog.pg_auth_members AS membership, owner_role, migrator_role
         WHERE membership.member = migrator_role.oid
       )
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
         JOIN owner_role ON owner_role.oid = membership.roleid
         JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
         WHERE member_role.rolname <> '${MIGRATOR_ROLE}'
            OR membership.admin_option
            OR membership.inherit_option
            OR NOT membership.set_option
       )
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members AS membership, migrator_role
         WHERE membership.roleid = migrator_role.oid
       );")"
  [[ "$edge_contract" == 't' ]] || fail 'migrator must have exactly one direct SET-only, no-admin owner membership'
}

verify_migrator_credential() {
  [[ -n "${BOARDSESH_LIBPQ_MIGRATOR_ENV_NAMES:-}" ]] || fail 'MIGRATOR_DATABASE_URL is required'
  assert_database MIGRATOR
  assert_role_contract MIGRATOR "$MIGRATOR_ROLE" 'true|false|false|false|true|false|false'
  assert_login_has_no_ddl_path MIGRATOR "$MIGRATOR_ROLE"
  local identity
  identity="$(run_connection MIGRATOR -Atq -c "SELECT session_user || '|' || current_user;")"
  [[ "$identity" == "$MIGRATOR_ROLE|$MIGRATOR_ROLE" ]] || fail 'deploy credential is not the exact migrator LOGIN'
  verify_migrator_edge MIGRATOR
  run_connection MIGRATOR -v owner_role="$OWNER_ROLE" <<'SQL' >/dev/null
BEGIN;
SELECT format('SET LOCAL ROLE %I;', :'owner_role')
\gexec
CREATE SCHEMA boardsesh_migrator_rollback_probe;
ROLLBACK;
SQL
  local rollback_probe
  rollback_probe="$(run_connection MIGRATOR -Atq \
    -c "SELECT pg_catalog.to_regnamespace('boardsesh_migrator_rollback_probe') IS NULL;")"
  [[ "$rollback_probe" == 't' ]] || fail 'migrator rollback probe left schema state behind'
  printf 'Deploy credential and rollback-only owner transition verified.\n'
}

probe_runtime_credential() {
  [[ -n "${BOARDSESH_LIBPQ_RUNTIME_ENV_NAMES:-}" ]] || fail 'RUNTIME_DATABASE_URL is required'
  assert_database RUNTIME
  assert_role_contract RUNTIME "$RUNTIME_ROLE" 'true|false|false|false|true|false|false'
  local identity
  identity="$(run_connection RUNTIME -Atq -F '|' -c 'SELECT session_user, current_user;')"
  [[ "$identity" == "$RUNTIME_ROLE|$RUNTIME_ROLE" ]] ||
    fail 'runtime URL must authenticate directly as the exact runtime LOGIN; startup SET ROLE is forbidden'
  assert_no_direct_memberships RUNTIME "$RUNTIME_ROLE"
  assert_login_has_no_ddl_path RUNTIME "$RUNTIME_ROLE"
  assert_schema_manifest RUNTIME
  local schemas
  schemas="$(schema_csv)"
  run_connection RUNTIME -v schemas="$schemas" <<'SQL' >/dev/null
BEGIN;
SELECT format('SELECT 1 FROM %I.%I LIMIT 0;', namespace.nspname, relation.relname)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p', 'v', 'm')
  AND namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
  AND NOT (
    relation.relname = '__drizzle_migrations'
    AND namespace.nspname IN ('public', 'drizzle')
  )
ORDER BY namespace.nspname, relation.relname
\gexec
ROLLBACK;
SQL
  local ledger_relation ledger_statement
  while IFS= read -r ledger_relation; do
    [[ -n "$ledger_relation" ]] || continue
    for ledger_statement in \
      "SELECT 1 FROM ${ledger_relation} LIMIT 0" \
      "INSERT INTO ${ledger_relation} DEFAULT VALUES" \
      "UPDATE ${ledger_relation} SET id = id WHERE false" \
      "DELETE FROM ${ledger_relation} WHERE false" \
      "TRUNCATE ${ledger_relation}"; do
      if run_connection RUNTIME -c "$ledger_statement" >/dev/null 2>&1; then
        fail "runtime credential unexpectedly accessed migration ledger $ledger_relation"
      fi
    done
  done < <(run_connection RUNTIME -Atq -c "
SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND relation.relname = '__drizzle_migrations'
  AND namespace.nspname IN ('public', 'drizzle')
ORDER BY 1;")
  if run_connection RUNTIME \
    -c 'BEGIN; CREATE SCHEMA boardsesh_runtime_must_not_create; ROLLBACK;' >/dev/null 2>&1; then
    fail 'runtime credential unexpectedly created a schema'
  fi
  printf 'Runtime rollback-only read probe and no-DDL boundary verified.\n'
}

transfer_ownership() {
  [[ "${DEPLOY_CREDENTIAL_ROTATED:-false}" == 'true' ]] ||
    fail 'set DEPLOY_CREDENTIAL_ROTATED=true only after verify-migrator passes for the deployed secret'
  [[ "${ROLLBACK_PROBES_CONFIRMED:-false}" == 'true' ]] ||
    fail 'set ROLLBACK_PROBES_CONFIRMED=true only after the runtime and app rollback probes pass'
  [[ -n "${BOARDSESH_LIBPQ_ADMIN_ENV_NAMES:-}" ]] || fail 'ADMIN_DATABASE_URL is required'
  verify_migrator_credential
  probe_runtime_credential
  assert_schema_manifest ADMIN

  local schemas ownership_statements
  schemas="$(schema_csv)"
  ownership_statements="$(
    cat <<'SQL'
SELECT format('ALTER SCHEMA %I OWNER TO %I;', namespace.nspname, :'owner_role')
FROM pg_catalog.pg_namespace AS namespace
WHERE namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
ORDER BY namespace.nspname
\gexec
SELECT format('ALTER %s %I.%I OWNER TO %I;',
              CASE relation.relkind WHEN 'S' THEN 'SEQUENCE'
                WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                ELSE 'TABLE' END,
              namespace.nspname, relation.relname, :'owner_role')
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p', 'S', 'v', 'm')
  AND namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND dependency.objid = relation.oid AND dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, relation.relname
\gexec
SELECT format('ALTER FUNCTION %s OWNER TO %I;', procedure.oid::pg_catalog.regprocedure, :'owner_role')
FROM pg_catalog.pg_proc AS procedure
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE procedure.prokind = 'f'
  AND namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, procedure.proname, procedure.oid
\gexec
SELECT format('ALTER PROCEDURE %s OWNER TO %I;', procedure.oid::pg_catalog.regprocedure, :'owner_role')
FROM pg_catalog.pg_proc AS procedure
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE procedure.prokind = 'p'
  AND namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, procedure.proname, procedure.oid
\gexec
SELECT format('ALTER TYPE %I.%I OWNER TO %I;', namespace.nspname, type_row.typname, :'owner_role')
FROM pg_catalog.pg_type AS type_row
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
-- Multirange ownership follows the owning range and cannot be altered directly.
WHERE type_row.typtype IN ('c', 'd', 'e', 'r')
  AND (type_row.typrelid = 0 OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS composite_relation
    WHERE composite_relation.oid = type_row.typrelid AND composite_relation.relkind = 'c'
  ))
  AND namespace.nspname IN (SELECT unnest(string_to_array(:'schemas', ', ')))
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
      AND dependency.objid = type_row.oid AND dependency.deptype = 'e'
  )
ORDER BY namespace.nspname, type_row.typname
\gexec
\if :inject_late_failure
DO $$ BEGIN RAISE EXCEPTION 'injected late transfer-ownership failure'; END $$;
\endif
SQL
  )"
  run_bounded_ddl_transaction transfer-ownership "$ownership_statements" \
    -v owner_role="$OWNER_ROLE" \
    -v schemas="$schemas" \
    -v inject_late_failure="${INJECT_LATE_FAILURE:-false}"
  printf 'Ownership transfer complete. Run the full read-only catalog audit before any cutover.\n'
}

usage() {
  cat <<'USAGE'
Usage: scripts/postgres18-production-role-transition.sh COMMAND

Commands, in mandatory order:
  prepare-source-acls  Pregrant current objects/defaults and install exact SET-only edge.
  verify-migrator      Verify the rotated deploy credential and rollback-only owner DDL.
  probe-runtime        Exercise zero-row app reads and prove runtime cannot CREATE schema.
  transfer-ownership   Re-runs both probes, then transfers ownership; requires
                       DEPLOY_CREDENTIAL_ROTATED=true and ROLLBACK_PROBES_CONFIRMED=true.

The canonical production database defaults to railway. The prepare phase creates or
repairs only the dedicated NOLOGIN fence-owner role; the owner, runtime, and migrator
roles must already exist. The script never rotates secrets and connects only when the
corresponding URL is explicitly supplied.

prepare-source-acls and transfer-ownership take ACCESS EXCLUSIVE on every relation
they touch, so run both in a low-traffic window. Each refuses to start while a
client transaction older than MAX_BLOCKING_TRANSACTION_SECONDS is open, runs its one
transaction under lock_timeout/statement_timeout, caps the total time that transaction
may hold its locks, and retries a blocked attempt DDL_LOCK_ATTEMPTS times before giving
up. Every attempt is all-or-nothing: a timeout or a watchdog cancel rolls the whole
transaction back, so giving up leaves the database untouched.

Lock-window tuning (milliseconds/seconds, defaults in parentheses):
  DDL_LOCK_TIMEOUT_MS (3000)              Wait per individual lock.
  DDL_STATEMENT_TIMEOUT_MS (60000)        Wait per individual statement.
  DDL_MAX_LOCK_HOLD_SECONDS (60)          Total ACCESS EXCLUSIVE hold per attempt.
                                          lock_timeout bounds one lock, not the
                                          150+ ALTERs in one transaction.
  DDL_LOCK_ATTEMPTS (5)                   Lock-blocked attempts before giving up.
  DDL_LOCK_RETRY_DELAY_SECONDS (15)       Pause between attempts.
  MAX_BLOCKING_TRANSACTION_SECONDS (60)   Oldest tolerated open client transaction.
USAGE
}

for role_name in "$OWNER_ROLE" "$RUNTIME_ROLE" "$MIGRATOR_ROLE" "$FENCE_OWNER_ROLE" "$EXPECTED_DATABASE"; do
  require_identifier role_contract "$role_name"
done
require_non_negative_integer DDL_LOCK_TIMEOUT_MS "$DDL_LOCK_TIMEOUT_MS"
require_non_negative_integer DDL_STATEMENT_TIMEOUT_MS "$DDL_STATEMENT_TIMEOUT_MS"
require_non_negative_integer DDL_LOCK_RETRY_DELAY_SECONDS "$DDL_LOCK_RETRY_DELAY_SECONDS"
require_non_negative_integer MAX_BLOCKING_TRANSACTION_SECONDS "$MAX_BLOCKING_TRANSACTION_SECONDS"
require_non_negative_integer DDL_LOCK_ATTEMPTS "$DDL_LOCK_ATTEMPTS"
[[ "$DDL_LOCK_ATTEMPTS" -ge 1 ]] || fail 'DDL_LOCK_ATTEMPTS must be at least 1'
# lock_timeout=0 disables the bound, which is the exact unbounded-queue failure
# this guard exists to prevent.
[[ "$DDL_LOCK_TIMEOUT_MS" -ge 1 ]] || fail 'DDL_LOCK_TIMEOUT_MS must be at least 1'
[[ "$DDL_STATEMENT_TIMEOUT_MS" -ge 1 ]] || fail 'DDL_STATEMENT_TIMEOUT_MS must be at least 1'
require_non_negative_integer DDL_MAX_LOCK_HOLD_SECONDS "$DDL_MAX_LOCK_HOLD_SECONDS"
# 0 would disable the wall-clock ceiling, which is the exact minutes-long
# ACCESS EXCLUSIVE hold this guard exists to prevent.
[[ "$DDL_MAX_LOCK_HOLD_SECONDS" -ge 1 ]] || fail 'DDL_MAX_LOCK_HOLD_SECONDS must be at least 1'
CREDENTIALS_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-pg18-role-transition.XXXXXX")"
cleanup() {
  if [[ -n "$DDL_WATCHDOG_PID" ]]; then
    kill "$DDL_WATCHDOG_PID" 2>/dev/null || true
  fi
  rm -rf "$CREDENTIALS_DIRECTORY"
}
trap cleanup EXIT
prepare_connections "$CREDENTIALS_DIRECTORY"

case "${1:-}" in
  prepare-source-acls) prepare_source_acl_policy ;;
  verify-migrator) verify_migrator_credential ;;
  probe-runtime) probe_runtime_credential ;;
  transfer-ownership) transfer_ownership ;;
  -h | --help | help) usage ;;
  *) usage; exit 1 ;;
esac
