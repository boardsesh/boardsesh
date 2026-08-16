#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPOSITORY_ROOT
readonly POSTGRES16_IMAGE='postgres:16.10-bookworm@sha256:38471f330eb885e04de130b768d6db4e10469e2311879c7e5c699f6d2d8a1c74'
readonly CONTAINER_NAME="boardsesh-pg16-role-transition-${GITHUB_RUN_ID:-local}-${$}"
readonly VOLUME_NAME="boardsesh-pg16-role-transition-${GITHUB_RUN_ID:-local}-${$}"
REPORT_FILE="$(mktemp "${TMPDIR:-/tmp}/boardsesh-pg16-role-transition.XXXXXX")"
readonly REPORT_FILE

BLOCKER_PID=''

cleanup() {
  if [[ -n "$BLOCKER_PID" ]]; then
    kill "$BLOCKER_PID" >/dev/null 2>&1 || true
    wait "$BLOCKER_PID" 2>/dev/null || true
  fi
  docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  rm -f "$REPORT_FILE"
}
trap cleanup EXIT

docker volume create "$VOLUME_NAME" >/dev/null
docker run --detach \
  --name "$CONTAINER_NAME" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=railway \
  --publish 127.0.0.1::5432 \
  --volume "$VOLUME_NAME:/var/lib/postgresql/data" \
  "$POSTGRES16_IMAGE" >/dev/null

host_port="$(docker port "$CONTAINER_NAME" 5432/tcp | sed -n 's/^127\.0\.0\.1://p' | head -n 1)"
[[ "$host_port" =~ ^[0-9]+$ ]]
readonly host_port

attempt=0
while [[ "$attempt" -lt 120 ]]; do
  if PGPASSWORD=postgres psql -X -Atq \
    -h 127.0.0.1 -p "$host_port" -U postgres -d railway \
    -c 'SELECT 1;' >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [[ "$attempt" -eq 120 ]]; then
  docker logs "$CONTAINER_NAME" >&2 || true
  printf 'PostgreSQL 16 transition fixture did not become ready\n' >&2
  exit 1
fi

readonly admin_url="postgresql://postgres:postgres@127.0.0.1:${host_port}/railway"
readonly migrator_url="postgresql://pg16_transition_migrator:migration-contract@127.0.0.1:${host_port}/railway"
readonly runtime_url="postgresql://pg16_transition_runtime:runtime-contract@127.0.0.1:${host_port}/railway"

PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE ROLE pg16_transition_owner NOLOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
GRANT CREATE, TEMPORARY ON DATABASE railway TO pg16_transition_owner WITH GRANT OPTION;
CREATE ROLE pg16_transition_runtime LOGIN PASSWORD 'runtime-contract'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg16_transition_migrator LOGIN PASSWORD 'migration-contract'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE pg16_transition_rogue_outgoing NOLOGIN;
CREATE ROLE pg16_transition_rogue_incoming NOLOGIN;
GRANT pg16_transition_rogue_outgoing TO pg16_transition_migrator;
GRANT pg16_transition_migrator TO pg16_transition_rogue_incoming;
CREATE SCHEMA pg16_transition;
GRANT USAGE ON SCHEMA pg16_transition TO pg16_transition_runtime WITH GRANT OPTION;
CREATE TABLE pg16_transition.probe (id integer PRIMARY KEY, marker text NOT NULL);
INSERT INTO pg16_transition.probe VALUES (1, 'must-survive-rollback');
GRANT SELECT (marker) ON TABLE pg16_transition.probe
  TO PUBLIC, pg16_transition_runtime;
CREATE FUNCTION pg16_transition.probe_function() RETURNS integer
  LANGUAGE sql AS 'SELECT 1';
CREATE PROCEDURE pg16_transition.probe_procedure()
  LANGUAGE sql AS 'SELECT 1';
SQL

transition_env=(
  EXPECTED_DATABASE=railway
  OWNER_ROLE=pg16_transition_owner
  RUNTIME_ROLE=pg16_transition_runtime
  MIGRATOR_ROLE=pg16_transition_migrator
  FENCE_OWNER_ROLE=pg16_transition_fence_owner
  INCLUDE_SCHEMAS=pg16_transition
)

if env "${transition_env[@]}" \
  INCLUDE_SCHEMAS='pg16_transition missing_transition_schema' \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
    prepare-source-acls >"$REPORT_FILE" 2>&1; then
  printf 'Expected a missing PG16 transition schema to fail before mutation\n' >&2
  exit 1
fi
grep -Fq 'every INCLUDE_SCHEMAS entry must exist exactly once before role transition' "$REPORT_FILE"
[[ "$(PGPASSWORD=postgres psql -X -Atq \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c \
  "SELECT to_regrole('pg16_transition_fence_owner') IS NULL;")" == 't' ]]

if env "${transition_env[@]}" \
  INJECT_LATE_FAILURE=true \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
    prepare-source-acls >"$REPORT_FILE" 2>&1; then
  printf 'Expected the injected PG16 prepare-source-acls failure\n' >&2
  exit 1
fi
grep -Fq 'injected late prepare-source-acls failure' "$REPORT_FILE"
rollback_contract="$(PGPASSWORD=postgres psql -X -Atq -F '|' \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "
SELECT (to_regrole('pg16_transition_fence_owner') IS NULL)::text || '|' ||
       (SELECT count(*) = 2 AND bool_and(privilege.is_grantable)
        FROM pg_database AS database
        JOIN pg_roles AS owner_role ON owner_role.rolname = 'pg16_transition_owner'
        CROSS JOIN LATERAL aclexplode(database.datacl) AS privilege
        WHERE database.datname = current_database()
          AND privilege.grantee = owner_role.oid
          AND privilege.privilege_type IN ('CREATE', 'TEMPORARY'))::text || '|' ||
       has_column_privilege('pg16_transition_runtime', 'pg16_transition.probe', 'marker', 'SELECT')::text || '|' ||
       (SELECT count(*) = 0 FROM pg_default_acl AS default_acl
        JOIN pg_roles AS owner_role ON owner_role.oid = default_acl.defaclrole
        WHERE owner_role.rolname = 'pg16_transition_owner')::text || '|' ||
       (SELECT attacl IS NOT NULL FROM pg_attribute
        WHERE attrelid = 'pg16_transition.probe'::regclass AND attname = 'marker')::text || '|' ||
       (SELECT count(*) = 1 AND bool_and(
                 privilege.privilege_type = 'USAGE' AND privilege.is_grantable)
        FROM pg_namespace AS namespace
        JOIN pg_roles AS runtime_role ON runtime_role.rolname = 'pg16_transition_runtime'
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
        WHERE namespace.nspname = 'pg16_transition'
          AND privilege.grantee = runtime_role.oid)::text;")"
[[ "$rollback_contract" == 'true|true|true|true|true|true' ]]

env "${transition_env[@]}" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
    prepare-source-acls >/dev/null

prepared_acl_contract="$(PGPASSWORD=postgres psql -X -Atq -F '|' \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "
SELECT (SELECT count(*) FROM pg_attribute AS attribute
        CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
        WHERE attribute.attrelid = 'pg16_transition.probe'::regclass
          AND attribute.attname = 'marker'
          AND privilege.grantee IN (
            0,
            (SELECT oid FROM pg_roles WHERE rolname = 'pg16_transition_runtime')
          ))::text || '|' ||
       (SELECT count(*) FROM pg_default_acl AS default_acl
        JOIN pg_roles AS owner_role ON owner_role.oid = default_acl.defaclrole
        CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS privilege
        WHERE owner_role.rolname = 'pg16_transition_owner'
          AND default_acl.defaclnamespace = 0
          AND default_acl.defaclobjtype IN ('f', 'T')
          AND privilege.grantee = 0)::text || '|' ||
       (SELECT count(*) = 1 AND bool_and(
                 privilege.privilege_type = 'USAGE' AND NOT privilege.is_grantable)
        FROM pg_namespace AS namespace
        JOIN pg_roles AS runtime_role ON runtime_role.rolname = 'pg16_transition_runtime'
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
        WHERE namespace.nspname = 'pg16_transition'
          AND privilege.grantee = runtime_role.oid)::text;")"
[[ "$prepared_acl_contract" == '0|0|true' ]]

[[ "$(PGPASSWORD=postgres psql -X -Atq \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "
SELECT count(*)
FROM pg_auth_members AS membership
JOIN pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE (member_role.rolname = 'pg16_transition_migrator'
       OR granted_role.rolname = 'pg16_transition_migrator')
  AND NOT (member_role.rolname = 'pg16_transition_migrator'
           AND granted_role.rolname = 'pg16_transition_owner');")" == '0' ]]

env "${transition_env[@]}" \
  MIGRATOR_DATABASE_URL="$migrator_url" \
  "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
    verify-migrator >/dev/null

if env "${transition_env[@]}" \
  RUNTIME_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${host_port}/railway?options=-c%20role%3Dpg16_transition_runtime" \
  "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
    probe-runtime >"$REPORT_FILE" 2>&1; then
  printf 'Expected a privileged URL using startup SET ROLE to fail runtime validation\n' >&2
  exit 1
fi
grep -Fq 'runtime URL must authenticate directly as the exact runtime LOGIN; startup SET ROLE is forbidden' \
  "$REPORT_FILE"

env "${transition_env[@]}" \
  RUNTIME_DATABASE_URL="$runtime_url" \
  "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
    probe-runtime >/dev/null

PGPASSWORD=runtime-contract psql -X -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p "$host_port" -U pg16_transition_runtime -d railway <<'SQL' >/dev/null
BEGIN;
INSERT INTO pg16_transition.probe VALUES (2, 'application-rollback-probe');
ROLLBACK;
SQL

if env "${transition_env[@]}" \
  DEPLOY_CREDENTIAL_ROTATED=true \
  ROLLBACK_PROBES_CONFIRMED=true \
  INJECT_LATE_FAILURE=true \
  ADMIN_DATABASE_URL="$admin_url" \
  MIGRATOR_DATABASE_URL="$migrator_url" \
  RUNTIME_DATABASE_URL="$runtime_url" \
  "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
    transfer-ownership >"$REPORT_FILE" 2>&1; then
  printf 'Expected the injected PG16 transfer-ownership failure\n' >&2
  exit 1
fi
grep -Fq 'injected late transfer-ownership failure' "$REPORT_FILE"
[[ "$(PGPASSWORD=postgres psql -X -Atq -F '|' \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "
SELECT pg_get_userbyid(namespace.nspowner) || '|' || pg_get_userbyid(relation.relowner)
FROM pg_namespace AS namespace
JOIN pg_class AS relation ON relation.relnamespace = namespace.oid
WHERE namespace.nspname = 'pg16_transition' AND relation.relname = 'probe';")" == 'postgres|postgres' ]]

owner_pair_query="
SELECT pg_get_userbyid(namespace.nspowner) || '|' || pg_get_userbyid(relation.relowner)
FROM pg_namespace AS namespace
JOIN pg_class AS relation ON relation.relnamespace = namespace.oid
WHERE namespace.nspname = 'pg16_transition' AND relation.relname = 'probe';"
readonly owner_pair_query

# A live primary always has readers. Hold ACCESS SHARE on the probe table from a
# second session so the ownership transfer collides with exactly the lock queue
# that would otherwise stall the site indefinitely.
PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway >/dev/null 2>&1 <<'SQL' &
BEGIN;
SELECT count(*) FROM pg16_transition.probe;
SELECT pg_sleep(120);
COMMIT;
SQL
BLOCKER_PID=$!

attempt=0
while [[ "$attempt" -lt 120 ]]; do
  if [[ "$(PGPASSWORD=postgres psql -X -Atq \
    -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "
SELECT count(*) FROM pg_locks AS lock_row
WHERE lock_row.relation = 'pg16_transition.probe'::regclass
  AND lock_row.mode = 'AccessShareLock'
  AND lock_row.granted
  AND lock_row.pid <> pg_backend_pid();")" == '1' ]]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[[ "$attempt" -lt 120 ]] || {
  printf 'The blocking reader never took its ACCESS SHARE lock\n' >&2
  exit 1
}
# pg_stat_activity ages are whole seconds, so let the blocker age past zero
# before asserting the long-transaction pre-flight.
sleep 2

if env "${transition_env[@]}" \
  DEPLOY_CREDENTIAL_ROTATED=true \
  ROLLBACK_PROBES_CONFIRMED=true \
  MAX_BLOCKING_TRANSACTION_SECONDS=0 \
  ADMIN_DATABASE_URL="$admin_url" \
  MIGRATOR_DATABASE_URL="$migrator_url" \
  RUNTIME_DATABASE_URL="$runtime_url" \
  "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
    transfer-ownership >"$REPORT_FILE" 2>&1; then
  printf 'Expected an open client transaction to block transfer-ownership before any DDL\n' >&2
  exit 1
fi
grep -Fq 'run it in a low-traffic window after clearing long-running transactions' "$REPORT_FILE"

# With the pre-flight satisfied, the same reader must turn into a bounded
# lock_timeout that rolls back and gives up instead of parking the lock queue.
if env "${transition_env[@]}" \
  DEPLOY_CREDENTIAL_ROTATED=true \
  ROLLBACK_PROBES_CONFIRMED=true \
  MAX_BLOCKING_TRANSACTION_SECONDS=3600 \
  DDL_LOCK_TIMEOUT_MS=500 \
  DDL_LOCK_ATTEMPTS=2 \
  DDL_LOCK_RETRY_DELAY_SECONDS=1 \
  ADMIN_DATABASE_URL="$admin_url" \
  MIGRATOR_DATABASE_URL="$migrator_url" \
  RUNTIME_DATABASE_URL="$runtime_url" \
  "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
    transfer-ownership >"$REPORT_FILE" 2>&1; then
  printf 'Expected a held ACCESS SHARE lock to bound and fail transfer-ownership\n' >&2
  exit 1
fi
grep -Fq 'transfer-ownership attempt 1 of 2 timed out on a lock and rolled back' "$REPORT_FILE"
grep -Fq 'gave up after 2 attempts blocked on locks' "$REPORT_FILE"
grep -Fq 'every attempt rolled back in full, so the database is untouched' "$REPORT_FILE"
[[ "$(PGPASSWORD=postgres psql -X -Atq -F '|' \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "$owner_pair_query")" == 'postgres|postgres' ]]

# lock_timeout bounds one acquisition, not the whole transaction's ACCESS
# EXCLUSIVE hold. Give it a lock_timeout no single wait can trip, and the
# wall-clock ceiling must be what ends the attempt - with the same full rollback
# and the same unchanged ownership.
if env "${transition_env[@]}" \
  DEPLOY_CREDENTIAL_ROTATED=true \
  ROLLBACK_PROBES_CONFIRMED=true \
  MAX_BLOCKING_TRANSACTION_SECONDS=3600 \
  DDL_LOCK_TIMEOUT_MS=600000 \
  DDL_STATEMENT_TIMEOUT_MS=600000 \
  DDL_MAX_LOCK_HOLD_SECONDS=3 \
  DDL_LOCK_ATTEMPTS=2 \
  DDL_LOCK_RETRY_DELAY_SECONDS=1 \
  ADMIN_DATABASE_URL="$admin_url" \
  MIGRATOR_DATABASE_URL="$migrator_url" \
  RUNTIME_DATABASE_URL="$runtime_url" \
  "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
    transfer-ownership >"$REPORT_FILE" 2>&1; then
  printf 'Expected the wall-clock lock-hold ceiling to end transfer-ownership\n' >&2
  exit 1
fi
grep -Fq 'transfer-ownership attempt 1 of 2 held its locks past the 3s ceiling and was cancelled and rolled back' \
  "$REPORT_FILE"
grep -Fq 'hold ceiling 3s' "$REPORT_FILE"
grep -Fq 'every attempt rolled back in full, so the database is untouched' "$REPORT_FILE"
[[ "$(PGPASSWORD=postgres psql -X -Atq -F '|' \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "$owner_pair_query")" == 'postgres|postgres' ]]
# The cancel must not leave the DDL session or its locks behind.
[[ "$(PGPASSWORD=postgres psql -X -Atq \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "
SELECT count(*) FROM pg_stat_activity
WHERE datname = current_database()
  AND application_name LIKE 'boardsesh-ddl-%';")" == '0' ]]

kill "$BLOCKER_PID" >/dev/null 2>&1 || true
wait "$BLOCKER_PID" 2>/dev/null || true
BLOCKER_PID=''
attempt=0
while [[ "$attempt" -lt 120 ]]; do
  if [[ "$(PGPASSWORD=postgres psql -X -Atq \
    -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "
SELECT count(*) FROM pg_locks AS lock_row
WHERE lock_row.relation = 'pg16_transition.probe'::regclass
  AND lock_row.pid <> pg_backend_pid();")" == '0' ]]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[[ "$attempt" -lt 120 ]] || {
  printf 'The blocking reader never released its lock\n' >&2
  exit 1
}

env "${transition_env[@]}" \
  DEPLOY_CREDENTIAL_ROTATED=true \
  ROLLBACK_PROBES_CONFIRMED=true \
  ADMIN_DATABASE_URL="$admin_url" \
  MIGRATOR_DATABASE_URL="$migrator_url" \
  RUNTIME_DATABASE_URL="$runtime_url" \
  "$REPOSITORY_ROOT/scripts/postgres18-production-role-transition.sh" \
    transfer-ownership >/dev/null

MIGRATION_OWNER_TEST_DATABASE_URL="$migrator_url" \
MIGRATION_OWNER_TEST_ADMIN_DATABASE_URL="$admin_url" \
MIGRATION_OWNER_TEST_LOGIN_ROLE=pg16_transition_migrator \
MIGRATION_OWNER_TEST_OWNER_ROLE=pg16_transition_owner \
MIGRATION_OWNER_TEST_FENCE_OWNER_ROLE=pg16_transition_fence_owner \
MIGRATION_OWNER_TEST_DATABASE_NAME=railway \
MIGRATION_OWNER_TEST_RUNTIME_DATABASE_URL="$runtime_url" \
MIGRATION_OWNER_TEST_RUNTIME_ROLE=pg16_transition_runtime \
MIGRATION_OWNER_TEST_RUNTIME_SCHEMAS=pg16_transition \
  node --import tsx --test \
    "$REPOSITORY_ROOT/packages/db/scripts/migration-owner-role.integration.test.ts"

final_contract="$(PGPASSWORD=postgres psql -X -Atq -F '|' \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "
SELECT current_setting('server_version_num')::integer / 10000 || '|' ||
       pg_get_userbyid(namespace.nspowner) || '|' ||
       pg_get_userbyid(relation.relowner) || '|' ||
       (SELECT count(*) FROM pg16_transition.probe) || '|' ||
       (SELECT count(*) = 1 AND bool_and(
                 privilege.privilege_type = 'CREATE' AND NOT privilege.is_grantable)
        FROM pg_database AS database
        JOIN pg_roles AS owner_role ON owner_role.rolname = 'pg16_transition_owner'
        CROSS JOIN LATERAL aclexplode(database.datacl) AS privilege
        WHERE database.datname = current_database()
          AND privilege.grantee = owner_role.oid)::text || '|' ||
       (SELECT count(*) = 1 AND bool_and(
                 NOT membership.admin_option AND NOT membership.inherit_option
                 AND membership.set_option)
        FROM pg_auth_members AS membership
        JOIN pg_roles AS member_role ON member_role.oid = membership.member
        JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
        WHERE member_role.rolname = 'pg16_transition_migrator'
          AND granted_role.rolname = 'pg16_transition_owner')::text || '|' ||
       (SELECT pg_get_userbyid(proowner) FROM pg_proc
        WHERE oid = 'pg16_transition.probe_function()'::regprocedure) || '|' ||
       (SELECT pg_get_userbyid(proowner) FROM pg_proc
        WHERE oid = 'pg16_transition.probe_procedure()'::regprocedure)
FROM pg_namespace AS namespace
JOIN pg_class AS relation ON relation.relnamespace = namespace.oid
WHERE namespace.nspname = 'pg16_transition' AND relation.relname = 'probe';")"
[[ "$final_contract" == '16|pg16_transition_owner|pg16_transition_owner|1|true|true|pg16_transition_owner|pg16_transition_owner' ]] || {
  printf 'PostgreSQL 16 production transition contract failed: %s\n' "$final_contract" >&2
  exit 1
}

printf 'PostgreSQL 16 transition, rollback, and reserved Drizzle owner-session smoke passed.\n'
