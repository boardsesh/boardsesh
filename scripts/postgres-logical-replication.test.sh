#!/usr/bin/env bash
set -Eeuo pipefail

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-replication-argv.XXXXXX")"
readonly TEST_ROOT

cleanup_test_root() {
  local exit_code=$?
  if [[ "$exit_code" -ne 0 && -f "${TRACE_LOG:-}" ]]; then
    tail -n 80 "$TRACE_LOG" >&2
  fi
  if [[ "$exit_code" -ne 0 && -f "${ERROR_LOG:-}" ]]; then
    tail -n 80 "$ERROR_LOG" >&2
  fi
  rm -rf "$TEST_ROOT"
  return "$exit_code"
}
trap cleanup_test_root EXIT

readonly FAKE_BIN="$TEST_ROOT/bin"
readonly ARGUMENT_LOG="$TEST_ROOT/arguments.log"
readonly CLEANUP_PATH_LOG="$TEST_ROOT/cleanup-path.log"
readonly SUBSCRIPTION_FILE_CHECK="$TEST_ROOT/subscription-file-checked"
readonly HYPOPG_CREATE_MARKER="$TEST_ROOT/hypopg-created"
readonly TRACE_LOG="$TEST_ROOT/helper.trace"
readonly ERROR_LOG="$TEST_ROOT/helper-error.trace"
readonly ROLE_STATEMENT_LOG="$TEST_ROOT/role-statements.log"
readonly SUBSCRIBER_DROPPED_MARKER="$TEST_ROOT/subscriber-dropped"
readonly REPLICATION_OBJECT_LOG="$TEST_ROOT/replication-objects.log"
readonly PUBLICATION_DROPPED_MARKER="$TEST_ROOT/publication-dropped"
readonly SLOT_DROPPED_MARKER="$TEST_ROOT/slot-dropped"
readonly SUBSCRIPTION_DROPPED_MARKER="$TEST_ROOT/subscription-dropped"
export ARGUMENT_LOG CLEANUP_PATH_LOG SUBSCRIPTION_FILE_CHECK HYPOPG_CREATE_MARKER \
  ROLE_STATEMENT_LOG SUBSCRIBER_DROPPED_MARKER REPLICATION_OBJECT_LOG \
  PUBLICATION_DROPPED_MARKER SLOT_DROPPED_MARKER SUBSCRIPTION_DROPPED_MARKER
mkdir -p "$FAKE_BIN"

assert_absent() {
  local needle="$1"
  shift
  if grep -Fq "$needle" "$@"; then
    printf 'Unexpected secret marker in captured helper output.\n' >&2
    exit 1
  fi
}

assert_fake_libpq_environment() {
  local expected_role="$1"
  [[ -f "${PGPASSFILE:-}" ]]
  [[ "$(stat -c '%a' "$PGPASSFILE" 2>/dev/null || stat -f '%Lp' "$PGPASSFILE")" == '600' ]]
  [[ -z "${PGHOSTADDR:-}" ]]
  [[ -z "${PGSERVICE:-}" ]]
  [[ -z "${PGSERVICEFILE:-}" ]]
  [[ -z "${PGPASSWORD:-}" ]]
  [[ -z "${PGSSLPASSWORD:-}" ]]
  [[ -z "${PGREQUIRESSL:-}" ]]
  [[ -z "${PGSYSCONFDIR:-}" ]]
  [[ -z "${PGLOCALEDIR:-}" ]]
  [[ "${PGSSLMODE:-}" == 'verify-full' ]]
  case "$expected_role" in
    source)
      [[ "${PGAPPNAME:-}" == 'argv-test' ]]
      [[ "$PGHOST" == '2001:db8::1' && "$PGPORT" == '5432' ]]
      [[ "$PGDATABASE" == 'main:db' && "$PGUSER" == 'source:user' ]]
      grep -Fxq '2001\:db8\:\:1:5432:main\:db:source\:user:source\:sec\\ret' "$PGPASSFILE"
      ;;
    target)
      [[ "${PGAPPNAME:-}" == 'argv-test' ]]
      [[ "$PGHOST" == 'target.example' && "$PGPORT" == '5432' ]]
      [[ "$PGDATABASE" == 'main' && "$PGUSER" == 'target' ]]
      grep -Fxq 'target.example:5432:main:target:target-secret' "$PGPASSFILE"
      ;;
    publisher)
      [[ "${PGAPPNAME:-}" == 'boardsesh_pg18_sub' ]]
      [[ "$PGHOST" == 'source.example' && "$PGPORT" == '5432' ]]
      [[ "$PGDATABASE" == 'main' && "$PGUSER" == 'publisher' ]]
      grep -Fxq 'source.example:5432:main:publisher:publisher-secret' "$PGPASSFILE"
      ;;
    *) exit 79 ;;
  esac
}
export -f assert_fake_libpq_environment

cat >"$FAKE_BIN/psql" <<'FAKE_PSQL'
#!/usr/bin/env bash
set -Eeuo pipefail

printf 'psql' >>"$ARGUMENT_LOG"
for argument in "$@"; do
  printf ' <%s>' "$argument" >>"$ARGUMENT_LOG"
done
printf '\n' >>"$ARGUMENT_LOG"

printf '%s\n' "${PGPASSFILE%/*}" >"$CLEANUP_PATH_LOG"
case "${PGUSER:-}" in
  'source:user') assert_fake_libpq_environment source ;;
  target) assert_fake_libpq_environment target ;;
  publisher) assert_fake_libpq_environment publisher ;;
  *) exit 80 ;;
esac

[[ " $* " == *' -X '* ]]
[[ " $* " != *'postgresql://'* && " $* " != *'postgres://'* ]]

sql=''
previous_argument=''
expect_sql=false
for argument in "$@"; do
  if [[ "$expect_sql" == true ]]; then
    sql="$argument"
    expect_sql=false
  elif [[ "$argument" == '-c' || "$argument" == '--command' || "$argument" =~ ^-[A-Za-z]*c[A-Za-z]*$ ]]; then
    expect_sql=true
  fi
  if [[ "$previous_argument" == '--file' || "$previous_argument" == '-f' ]]; then
    [[ -f "$argument" ]]
    [[ "$(stat -c '%a' "$argument" 2>/dev/null || stat -f '%Lp' "$argument")" == '600' ]]
    if grep -Fq 'CREATE SUBSCRIPTION' "$argument"; then
      [[ "$(head -n 1 "$argument")" == 'SET standard_conforming_strings = on;' ]]
      grep -Fq "CONNECTION 'host=''source.example'' port=''5432'' dbname=''main'' user=''publisher'' password=''publisher-secret'' application_name=''boardsesh_pg18_sub'' sslmode=''verify-full'' '" "$argument"
      grep -Eq "COMMENT ON SUBSCRIPTION boardsesh_pg18_sub IS 'boardsesh-pg18-conninfo-v1:[0-9a-f]{32}';" "$argument"
      : >"$SUBSCRIPTION_FILE_CHECK"
    fi
  fi
  previous_argument="$argument"
done
if [[ -z "$sql" && ! -t 0 ]]; then
  sql="$(</dev/stdin)"
fi
if [[ "$sql" == *'CREATE EXTENSION IF NOT EXISTS hypopg'* ]]; then
  : >"$HYPOPG_CREATE_MARKER"
fi
# Teardown's role cleanup is the only path that emits REVOKE/DROP ROLE, so record
# exactly what it would have run and simulate the role disappearing afterwards.
if [[ "$sql" == *'DROP ROLE'* || "$sql" == *'REVOKE '* ]]; then
  printf '%s\n' "$sql" >>"$ROLE_STATEMENT_LOG"
fi
if [[ "$sql" == *'DROP ROLE'* ]]; then
  : >"$SUBSCRIBER_DROPPED_MARKER"
fi
# Replication-object teardown, recorded the same way so a run can prove the slot
# and publication went away even when a later step refuses to continue.
if [[ "$sql" == *'DROP PUBLICATION'* ]]; then
  printf '%s\n' "$sql" >>"$REPLICATION_OBJECT_LOG"
  : >"$PUBLICATION_DROPPED_MARKER"
fi
if [[ "$sql" == *'pg_drop_replication_slot'* ]]; then
  printf '%s\n' "$sql" >>"$REPLICATION_OBJECT_LOG"
  : >"$SLOT_DROPPED_MARKER"
fi
if [[ "$sql" == *'DROP SUBSCRIPTION'* ]]; then
  printf '%s\n' "$sql" >>"$REPLICATION_OBJECT_LOG"
  : >"$SUBSCRIPTION_DROPPED_MARKER"
fi

case "$sql" in
  *'SHOW wal_level'*) printf 'logical\n' ;;
  *'SELECT current_database()'*) printf 'main\n' ;;
  *'SELECT session_user, current_user'*) printf '%s\n' "${FAKE_PUBLISHER_IDENTITY:-publisher|publisher}" ;;
  *"SHOW row_security"*) printf 'off\n' ;;
  *'FROM pg_roles AS subscriber'*)
    if [[ -f "$SUBSCRIBER_DROPPED_MARKER" ]]; then
      printf '0\n'
    else
      printf '%s\n' "${FAKE_SUBSCRIBER_ROLE_COUNT:-0}"
    fi
    ;;
  *'create_subscription_role AS'*)
    if [[ -n "${FAKE_SUBSCRIBER_CONTRACT:-}" ]]; then
      printf '%s\n' "$FAKE_SUBSCRIBER_CONTRACT"
    else
      if [[ -f "$SUBSCRIPTION_FILE_CHECK" ]]; then subscription_count=1; else subscription_count=0; fi
      printf 'true|false|false|false|true|false|false|true|true|true|true|true|true|true|true|true|%s\n' "$subscription_count"
    fi
    ;;
  *'control_function_contract AS'*) printf 'false|false|false|false|true|false|false|true|true|true|true|true|true|true|true|true|true|true\n' ;;
  *'WITH migrator AS ('*) printf 'true|false|false|false|true|false|false|true|true|true|true|true\n' ;;
  *"role.rolname = 'boardsesh_runtime'"*) printf 'true|false|false|false|true|false|false|true|true|true|true|true\n' ;;
  *'WITH owner_role AS ('*'aclexplode(database.datacl)'*) printf 't\n' ;;
  *"rolcanlogin::text"*"WHERE rolname = current_user"*) printf '%s\n' "${FAKE_PUBLISHER_CONTRACT:-true|false|false|false|true|true|false|true|true|true|true|true}" ;;
  *"has_database_privilege(oid, current_database(), 'CREATE')"*) printf 't\n' ;;
  *'FROM pg_subscription AS subscription'*) printf 't\n' ;;
  *'FROM pg_publication AS publication'*) printf 't\n' ;;
  *'FROM pg_subscription_rel AS subscription_relation'*) printf 'public.example\n' ;;
  *'SELECT string_agg('*|*"SELECT format('%I.%I', n.nspname, c.relname)"*) printf 'public.example\n' ;;
  *"FROM pg_extension WHERE extname = 'hypopg'"*) printf '%s\n' "${FAKE_SOURCE_HYPOPG:-0}" ;;
  *'FROM pg_catalog.pg_attribute AS attribute'*) printf '%s\n' "${FAKE_COLUMN_ACL_COUNT:-0}" ;;
  *'FROM pg_subscription WHERE subname'*)
    if [[ "${FAKE_SUBSCRIPTION_EXISTS:-0}" == '1' && ! -f "$SUBSCRIPTION_DROPPED_MARKER" ]]; then
      printf '1\n'
    elif [[ "$sql" == *'count(*)'* ]]; then
      printf '0\n'
    fi
    ;;
  *'FROM pg_publication WHERE pubname'*)
    if [[ "${FAKE_PUBLICATION_EXISTS:-0}" == '1' && ! -f "$PUBLICATION_DROPPED_MARKER" ]]; then
      printf '1\n'
    elif [[ "$sql" == *'count(*)'* ]]; then
      printf '0\n'
    fi
    ;;
  *'FROM pg_replication_slots'*)
    # The contract probes only run once the slot is known to exist, so they
    # always answer "matches"; the count probes track the simulated drop.
    if [[ "$sql" == *'count(*) = 1'* ]]; then
      printf 't\n'
    elif [[ "${FAKE_SLOT_EXISTS:-0}" == '1' && ! -f "$SLOT_DROPPED_MARKER" ]]; then
      printf '1\n'
    else
      printf '0\n'
    fi
    ;;
  *"SELECT format('%I.%I', namespace.nspname, relation.relname)"*) printf 'public.example\n' ;;
  *'SELECT count(*)'*) printf '0\n' ;;
esac
FAKE_PSQL

cat >"$FAKE_BIN/pg_dump" <<'FAKE_PG_DUMP'
#!/usr/bin/env bash
set -Eeuo pipefail
assert_fake_libpq_environment source
printf 'pg_dump' >>"$ARGUMENT_LOG"
output_file=''
previous_argument=''
for argument in "$@"; do
  printf ' <%s>' "$argument" >>"$ARGUMENT_LOG"
  if [[ "$previous_argument" == '--file' ]]; then
    output_file="$argument"
  fi
  previous_argument="$argument"
done
printf '\n' >>"$ARGUMENT_LOG"
[[ " $* " != *'postgresql://'* && " $* " != *'postgres://'* ]]
[[ -n "$output_file" ]]
: >"$output_file"
FAKE_PG_DUMP

cat >"$FAKE_BIN/pg_restore" <<'FAKE_PG_RESTORE'
#!/usr/bin/env bash
set -Eeuo pipefail
assert_fake_libpq_environment target
printf 'pg_restore' >>"$ARGUMENT_LOG"
for argument in "$@"; do
  printf ' <%s>' "$argument" >>"$ARGUMENT_LOG"
done
printf '\n' >>"$ARGUMENT_LOG"
[[ " $* " != *'postgresql://'* && " $* " != *'postgres://'* ]]
FAKE_PG_RESTORE

chmod +x "$FAKE_BIN/psql" "$FAKE_BIN/pg_dump" "$FAKE_BIN/pg_restore"

PATH="$FAKE_BIN:$PATH" \
PGHOST='poison-host' \
PGHOSTADDR='127.0.0.66' \
PGSERVICE='poison-service' \
PGSERVICEFILE='/poison/service.conf' \
PGPASSFILE='/poison/passfile' \
PGPASSWORD='inherited-password-secret' \
PGSSLPASSWORD='inherited-ssl-secret' \
PGREQUIRESSL='1' \
PGSYSCONFDIR='/poison/system' \
PGLOCALEDIR='/poison/locale' \
NEON_DATABASE_URL='postgresql://source%3Auser:source%3Asec%5Cret@[2001:db8::1]/main%3Adb?sslmode=verify-full&application_name=argv-test' \
RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example:5432/main?sslmode=verify-full&application_name=argv-test' \
NEON_REPLICATION_DATABASE_URL='postgresql://publisher:publisher-secret@source.example:5432/main?sslmode=verify-full&application_name=boardsesh_pg18_sub' \
TARGET_OWNER_ROLE=boardsesh_owner \
TARGET_MIGRATOR_ROLE=boardsesh_migrator \
TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
TARGET_RUNTIME_ROLE=boardsesh_runtime \
TARGET_RUNTIME_SCHEMAS=public \
SOURCE_DATABASE_NAME=main \
TARGET_DATABASE_NAME=main \
CHECK_TABLES=example \
  bash -x "$PWD/scripts/postgres-logical-replication.sh" setup >/dev/null 2>"$TRACE_LOG"

[[ -f "$SUBSCRIPTION_FILE_CHECK" ]]
[[ ! -e "$HYPOPG_CREATE_MARKER" ]]
assert_absent 'source%3Asec%5Cret' "$ARGUMENT_LOG" "$TRACE_LOG"
assert_absent 'source:sec\ret' "$ARGUMENT_LOG" "$TRACE_LOG"
assert_absent 'target-secret' "$ARGUMENT_LOG"
assert_absent 'publisher-secret' "$ARGUMENT_LOG"
assert_absent 'target-secret' "$TRACE_LOG"
assert_absent 'publisher-secret' "$TRACE_LOG"
assert_absent 'inherited-password-secret' "$ARGUMENT_LOG" "$TRACE_LOG"
assert_absent 'inherited-ssl-secret' "$ARGUMENT_LOG" "$TRACE_LOG"
assert_absent 'postgresql://' "$ARGUMENT_LOG"
assert_absent 'postgres://' "$ARGUMENT_LOG"
grep -Fq 'psql <-X>' "$ARGUMENT_LOG"
grep -Fq 'pg_dump' "$ARGUMENT_LOG"
grep -Fq 'pg_restore' "$ARGUMENT_LOG"
[[ ! -e "$(<"$CLEANUP_PATH_LOG")" ]]

rm -f "$SUBSCRIPTION_FILE_CHECK" "$HYPOPG_CREATE_MARKER"
PATH="$FAKE_BIN:$PATH" \
FAKE_SOURCE_HYPOPG=1 \
NEON_DATABASE_URL='postgresql://source%3Auser:source%3Asec%5Cret@[2001:db8::1]/main%3Adb?sslmode=verify-full&application_name=argv-test' \
RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example:5432/main?sslmode=verify-full&application_name=argv-test' \
NEON_REPLICATION_DATABASE_URL='postgresql://publisher:publisher-secret@source.example:5432/main?sslmode=verify-full&application_name=boardsesh_pg18_sub' \
TARGET_OWNER_ROLE=boardsesh_owner \
TARGET_MIGRATOR_ROLE=boardsesh_migrator \
TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
TARGET_RUNTIME_ROLE=boardsesh_runtime \
TARGET_RUNTIME_SCHEMAS=public \
SOURCE_DATABASE_NAME=main \
TARGET_DATABASE_NAME=main \
LOAD_SCHEMA=false \
  bash "$PWD/scripts/postgres-logical-replication.sh" setup >/dev/null 2>"$ERROR_LOG"
[[ -f "$HYPOPG_CREATE_MARKER" ]]

: >"$ARGUMENT_LOG"
if PATH="$FAKE_BIN:$PATH" \
  FAKE_COLUMN_ACL_COUNT=1 \
  NEON_DATABASE_URL='postgresql://source%3Auser:source%3Asec%5Cret@[2001:db8::1]/main%3Adb?sslmode=verify-full&application_name=argv-test' \
  RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example:5432/main?sslmode=verify-full&application_name=argv-test' \
  NEON_REPLICATION_DATABASE_URL='postgresql://publisher:publisher-secret@source.example:5432/main?sslmode=verify-full&application_name=boardsesh_pg18_sub' \
  TARGET_OWNER_ROLE=boardsesh_owner \
  TARGET_MIGRATOR_ROLE=boardsesh_migrator \
  TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
  TARGET_RUNTIME_ROLE=boardsesh_runtime \
  TARGET_RUNTIME_SCHEMAS=public \
  SOURCE_DATABASE_NAME=main \
  TARGET_DATABASE_NAME=main \
    bash "$PWD/scripts/postgres-logical-replication.sh" setup >/dev/null 2>"$ERROR_LOG"; then
  printf 'Expected a source column ACL to fail before target setup.\n' >&2
  exit 1
fi
grep -Fq 'source has 1 included non-extension column ACL(s)' "$ERROR_LOG"
if grep -Fq 'pg_dump' "$ARGUMENT_LOG"; then
  printf 'Column ACL rejection occurred after schema dump started.\n' >&2
  exit 1
fi

: >"$ARGUMENT_LOG"
if PATH="$FAKE_BIN:$PATH" \
  FAKE_PUBLISHER_CONTRACT='true|false|false|false|true|true|false|true|true|true|true|false' \
  NEON_DATABASE_URL='postgresql://source%3Auser:source%3Asec%5Cret@[2001:db8::1]/main%3Adb?sslmode=verify-full&application_name=argv-test' \
  RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example:5432/main?sslmode=verify-full&application_name=argv-test' \
  NEON_REPLICATION_DATABASE_URL='postgresql://publisher:publisher-secret@source.example:5432/main?sslmode=verify-full&application_name=boardsesh_pg18_sub' \
  TARGET_OWNER_ROLE=boardsesh_owner \
  TARGET_MIGRATOR_ROLE=boardsesh_migrator \
  TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
  TARGET_RUNTIME_ROLE=boardsesh_runtime \
  TARGET_RUNTIME_SCHEMAS=public \
  SOURCE_DATABASE_NAME=main \
  TARGET_DATABASE_NAME=main \
    bash "$PWD/scripts/postgres-logical-replication.sh" setup >/dev/null 2>"$ERROR_LOG"; then
  printf 'Expected publisher DDL/DML boundary drift to fail before target setup.\n' >&2
  exit 1
fi
grep -Fq 'publisher credential must be an ownership-free exact replication LOGIN' "$ERROR_LOG"
if grep -Fq 'pg_dump' "$ARGUMENT_LOG"; then
  printf 'Publisher boundary rejection occurred after schema dump started.\n' >&2
  exit 1
fi
assert_absent 'source:sec\ret' "$ARGUMENT_LOG" "$ERROR_LOG"
assert_absent 'target-secret' "$ARGUMENT_LOG" "$ERROR_LOG"
assert_absent 'publisher-secret' "$ARGUMENT_LOG" "$ERROR_LOG"

: >"$ARGUMENT_LOG"
if PATH="$FAKE_BIN:$PATH" \
  NEON_DATABASE_URL='postgresql://source:source-secret@source.example/main' \
  RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example/main' \
  NEON_REPLICATION_DATABASE_URL='postgresql://publisher:publisher-secret@source.example/main' \
  TARGET_OWNER_ROLE=boardsesh_owner \
  TARGET_MIGRATOR_ROLE=boardsesh_migrator \
  TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
  TARGET_RUNTIME_ROLE=boardsesh_runtime \
  TARGET_RUNTIME_SCHEMAS=public \
  INCLUDE_SCHEMAS='public public' \
  EXCLUDE_SCHEMAS='public neon_auth' \
  SOURCE_DATABASE_NAME=main \
  TARGET_DATABASE_NAME=main \
    bash "$PWD/scripts/postgres-logical-replication.sh" setup >/dev/null 2>"$ERROR_LOG"; then
  printf 'Expected overlapping/duplicate helper schema policy to fail.\n' >&2
  exit 1
fi
grep -Eq 'contains duplicate schema|cannot appear in both' "$ERROR_LOG"
if grep -Fq 'pg_dump' "$ARGUMENT_LOG"; then
  printf 'Schema policy rejection occurred after schema dump started.\n' >&2
  exit 1
fi
assert_absent 'source-secret' "$ERROR_LOG"
assert_absent 'target-secret' "$ERROR_LOG"
assert_absent 'publisher-secret' "$ERROR_LOG"

: >"$ARGUMENT_LOG"
if PATH="$FAKE_BIN:$PATH" \
  FAKE_PUBLISHER_IDENTITY='postgres|publisher' \
  NEON_DATABASE_URL='postgresql://source%3Auser:source%3Asec%5Cret@[2001:db8::1]/main%3Adb?sslmode=verify-full&application_name=argv-test' \
  RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example:5432/main?sslmode=verify-full&application_name=argv-test' \
  NEON_REPLICATION_DATABASE_URL='postgresql://publisher:publisher-secret@source.example:5432/main?sslmode=verify-full&application_name=boardsesh_pg18_sub' \
  TARGET_OWNER_ROLE=boardsesh_owner \
  TARGET_MIGRATOR_ROLE=boardsesh_migrator \
  TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
  TARGET_RUNTIME_ROLE=boardsesh_runtime \
  TARGET_RUNTIME_SCHEMAS=public \
  SOURCE_DATABASE_NAME=main \
  TARGET_DATABASE_NAME=main \
    bash "$PWD/scripts/postgres-logical-replication.sh" setup >/dev/null 2>"$ERROR_LOG"; then
  printf 'Expected startup SET ROLE publisher URL to fail before target setup.\n' >&2
  exit 1
fi
grep -Fq 'publisher URL must authenticate directly as its restricted role; startup SET ROLE is forbidden' \
  "$ERROR_LOG"
if grep -Fq 'pg_dump' "$ARGUMENT_LOG"; then
  printf 'Publisher identity rejection occurred after schema dump started.\n' >&2
  exit 1
fi
assert_absent 'source:sec\ret' "$ARGUMENT_LOG" "$ERROR_LOG"
assert_absent 'target-secret' "$ARGUMENT_LOG" "$ERROR_LOG"
assert_absent 'publisher-secret' "$ARGUMENT_LOG" "$ERROR_LOG"

if PATH="$FAKE_BIN:$PATH" \
  NEON_DATABASE_URL='postgresql://source:error-secret%ZZ@source.example/main' \
  RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example/main' \
  TARGET_OWNER_ROLE=boardsesh_owner \
  TARGET_MIGRATOR_ROLE=boardsesh_migrator \
  TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
  TARGET_RUNTIME_ROLE=boardsesh_runtime \
  TARGET_RUNTIME_SCHEMAS=public \
  SOURCE_DATABASE_NAME=main \
  TARGET_DATABASE_NAME=main \
  bash -x "$PWD/scripts/postgres-logical-replication.sh" status \
  >/dev/null 2>"$ERROR_LOG"; then
  printf 'Expected an invalid percent escape to fail.\n' >&2
  exit 1
fi
grep -Fq 'database URL contains an invalid percent escape' "$ERROR_LOG"
assert_absent 'error-secret' "$ERROR_LOG"
assert_absent 'target-secret' "$ERROR_LOG"

if PATH="$FAKE_BIN:$PATH" \
  NEON_DATABASE_URL='postgresql://source@source.example/main?pass%77ord=query-secret' \
  RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example/main' \
  TARGET_OWNER_ROLE=boardsesh_owner \
  TARGET_MIGRATOR_ROLE=boardsesh_migrator \
  TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
  TARGET_RUNTIME_ROLE=boardsesh_runtime \
  TARGET_RUNTIME_SCHEMAS=public \
  SOURCE_DATABASE_NAME=main \
  TARGET_DATABASE_NAME=main \
  bash -x "$PWD/scripts/postgres-logical-replication.sh" status \
  >/dev/null 2>"$ERROR_LOG"; then
  printf 'Expected an encoded password query parameter to fail.\n' >&2
  exit 1
fi
grep -Fq 'database URL query option password would bypass validated URI fields' "$ERROR_LOG"
assert_absent 'query-secret' "$ERROR_LOG"
assert_absent 'target-secret' "$ERROR_LOG"

for rejected_option in host hostaddr service passfile sslpassword; do
  if PATH="$FAKE_BIN:$PATH" \
    NEON_DATABASE_URL="postgresql://source:source-secret@source.example/main?${rejected_option}=query-secret" \
    RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example/main' \
    TARGET_OWNER_ROLE=boardsesh_owner \
    TARGET_MIGRATOR_ROLE=boardsesh_migrator \
    TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
    TARGET_RUNTIME_ROLE=boardsesh_runtime \
    SOURCE_DATABASE_NAME=main \
    TARGET_DATABASE_NAME=main \
    bash -x "$PWD/scripts/postgres-logical-replication.sh" status \
    >/dev/null 2>"$ERROR_LOG"; then
    printf 'Expected query override %s to fail.\n' "$rejected_option" >&2
    exit 1
  fi
  grep -Fq "database URL query option ${rejected_option} would bypass validated URI fields" "$ERROR_LOG"
  assert_absent 'source-secret' "$ERROR_LOG"
  assert_absent 'query-secret' "$ERROR_LOG"
  assert_absent 'target-secret' "$ERROR_LOG"
done

if PATH="$FAKE_BIN:$PATH" \
  NEON_DATABASE_URL='postgresql://source%3Auser:source%3Asec%5Cret@[2001:db8::1]/main%3Adb?sslmode=verify-full&application_name=argv-test' \
  RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example:5432/main?sslmode=verify-full&application_name=argv-test' \
  NEON_REPLICATION_DATABASE_URL='postgresql://publisher:publisher-secret@source.example/main?sslmode=verify-full&application_name=rogue-worker' \
  TARGET_OWNER_ROLE=boardsesh_owner \
  TARGET_MIGRATOR_ROLE=boardsesh_migrator \
  TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
  TARGET_RUNTIME_ROLE=boardsesh_runtime \
  TARGET_RUNTIME_SCHEMAS=public \
  SOURCE_DATABASE_NAME=main \
  TARGET_DATABASE_NAME=main \
  bash -x "$PWD/scripts/postgres-logical-replication.sh" setup \
  >/dev/null 2>"$ERROR_LOG"; then
  printf 'Expected a noncanonical publisher application_name to fail.\n' >&2
  exit 1
fi
grep -Fq 'publisher application_name must equal the canonical subscription name boardsesh_pg18_sub' "$ERROR_LOG" || {
  cat "$ERROR_LOG" >&2
  exit 1
}
assert_absent 'source-secret' "$ERROR_LOG"
assert_absent 'target-secret' "$ERROR_LOG"
assert_absent 'publisher-secret' "$ERROR_LOG"

# Teardown's temporary-subscriber cleanup. The fake psql answers the role-count
# probe and the contract query, so these cases pin the control flow and the exact
# statements the helper would issue; the real catalog behaviour is exercised
# against live PostgreSQL by scripts/postgres18-image-smoke.sh.
readonly GOOD_SUBSCRIBER_CONTRACT='true|false|false|false|true|false|false|true|true|true|true|true|true|true|true|true|0'

run_teardown() {
  PATH="$FAKE_BIN:$PATH" \
    NEON_DATABASE_URL='postgresql://source%3Auser:source%3Asec%5Cret@[2001:db8::1]/main%3Adb?sslmode=verify-full&application_name=argv-test' \
    RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example:5432/main?sslmode=verify-full&application_name=argv-test' \
    NEON_REPLICATION_DATABASE_URL='postgresql://publisher:publisher-secret@source.example:5432/main?sslmode=verify-full&application_name=boardsesh_pg18_sub' \
    TARGET_OWNER_ROLE=boardsesh_owner \
    TARGET_MIGRATOR_ROLE=boardsesh_migrator \
    TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
    SOURCE_DATABASE_NAME=main \
    TARGET_DATABASE_NAME=main \
    TEARDOWN_CONFIRMED=true \
    bash "$PWD/scripts/postgres-logical-replication.sh" teardown
}

rm -f "$SUBSCRIBER_DROPPED_MARKER"
: >"$ROLE_STATEMENT_LOG"
: >"$ARGUMENT_LOG"

# 1. Role absent: skip with a clear message and touch no role at all.
FAKE_SUBSCRIBER_ROLE_COUNT=0 run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected teardown to succeed when the subscriber role is already gone.\n' >&2
  exit 1
}
grep -Fq "Temporary subscriber role 'boardsesh_pg18_subscriber' does not exist" "$ERROR_LOG"
if [[ -s "$ROLE_STATEMENT_LOG" ]]; then
  printf 'Teardown emitted role statements for an absent subscriber role.\n' >&2
  exit 1
fi

# 2. A role wearing the name but failing the contract must never be dropped.
for violating_contract in \
  'true|false|false|false|true|false|false|false|true|true|true|true|true|true|true|true|0' \
  'true|false|false|false|true|false|false|true|true|true|true|true|true|true|false|true|0'; do
  : >"$ROLE_STATEMENT_LOG"
  if FAKE_SUBSCRIBER_ROLE_COUNT=1 FAKE_SUBSCRIBER_CONTRACT="$violating_contract" \
    run_teardown >"$ERROR_LOG" 2>&1; then
    printf 'Expected teardown to refuse a contract-violating subscriber role.\n' >&2
    exit 1
  fi
  grep -Fq 'teardown refuses to drop any other role' "$ERROR_LOG"
  grep -Fq 'TARGET_SUBSCRIBER_ROLE must be a passwordless ownership-free exact LOGIN' "$ERROR_LOG"
  if [[ -s "$ROLE_STATEMENT_LOG" ]]; then
    printf 'Teardown emitted role statements despite a contract violation.\n' >&2
    exit 1
  fi
done

# 3. Happy path: revoke, drop, and prove the role is gone.
: >"$ROLE_STATEMENT_LOG"
FAKE_SUBSCRIBER_ROLE_COUNT=1 FAKE_SUBSCRIBER_CONTRACT="$GOOD_SUBSCRIBER_CONTRACT" \
  run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected teardown to drop a contract-matching subscriber role.\n' >&2
  exit 1
}
grep -Fq "Temporary subscriber role 'boardsesh_pg18_subscriber' removed" "$ERROR_LOG"
grep -Fq "DROP ROLE %I;', 'boardsesh_pg18_subscriber'" "$ROLE_STATEMENT_LOG"
grep -Fq "DROP OWNED BY %I;', 'boardsesh_pg18_subscriber'" "$ROLE_STATEMENT_LOG"
grep -Fq 'REVOKE ALL PRIVILEGES ON DATABASE' "$ROLE_STATEMENT_LOG"
grep -Fq 'REVOKE ALL PRIVILEGES ON SCHEMA' "$ROLE_STATEMENT_LOG"
assert_absent 'boardsesh_owner' "$ROLE_STATEMENT_LOG"
assert_absent 'boardsesh_migrator' "$ROLE_STATEMENT_LOG"

# 4. Re-running after a successful teardown stays green and stays inert.
: >"$ROLE_STATEMENT_LOG"
FAKE_SUBSCRIBER_ROLE_COUNT=1 FAKE_SUBSCRIBER_CONTRACT="$GOOD_SUBSCRIBER_CONTRACT" \
  run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected a teardown re-run after success to succeed.\n' >&2
  exit 1
}
grep -Fq "Temporary subscriber role 'boardsesh_pg18_subscriber' does not exist" "$ERROR_LOG"
if [[ -s "$ROLE_STATEMENT_LOG" ]]; then
  printf 'A teardown re-run emitted role statements after the role was dropped.\n' >&2
  exit 1
fi
assert_absent 'source:sec\ret' "$ARGUMENT_LOG" "$ERROR_LOG"
assert_absent 'target-secret' "$ARGUMENT_LOG" "$ERROR_LOG"
assert_absent 'publisher-secret' "$ARGUMENT_LOG" "$ERROR_LOG"

# 5. The WAL emergency in the runbook: setup aborted, the source is retaining WAL
# behind an orphan slot, and the shell reaching for teardown no longer carries the
# two role names. Replication-object teardown must still run to completion; only
# the role cleanup may refuse, and it must refuse loudly.
run_teardown_without_role_variables() {
  PATH="$FAKE_BIN:$PATH" \
    NEON_DATABASE_URL='postgresql://source%3Auser:source%3Asec%5Cret@[2001:db8::1]/main%3Adb?sslmode=verify-full&application_name=argv-test' \
    RAILWAY_DATABASE_URL='postgresql://target:target-secret@target.example:5432/main?sslmode=verify-full&application_name=argv-test' \
    NEON_REPLICATION_DATABASE_URL='postgresql://publisher:publisher-secret@source.example:5432/main?sslmode=verify-full&application_name=boardsesh_pg18_sub' \
    SOURCE_DATABASE_NAME=main \
    TARGET_DATABASE_NAME=main \
    TEARDOWN_CONFIRMED=true \
    bash "$PWD/scripts/postgres-logical-replication.sh" teardown
}

rm -f "$SUBSCRIBER_DROPPED_MARKER" "$PUBLICATION_DROPPED_MARKER" "$SLOT_DROPPED_MARKER"
: >"$ROLE_STATEMENT_LOG"
: >"$REPLICATION_OBJECT_LOG"
if FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
  run_teardown_without_role_variables >"$ERROR_LOG" 2>&1; then
  printf 'Expected teardown without the role variables to stop at role cleanup.\n' >&2
  exit 1
fi
grep -Fq 'export TARGET_OWNER_ROLE and TARGET_SUBSCRIBER_ROLE and re-run teardown' "$ERROR_LOG" || {
  cat "$ERROR_LOG" >&2
  exit 1
}
grep -Fq 'pg_drop_replication_slot' "$REPLICATION_OBJECT_LOG" || {
  cat "$ERROR_LOG" >&2
  printf 'Teardown left the WAL-retaining orphan slot in place.\n' >&2
  exit 1
}
grep -Fq 'DROP PUBLICATION boardsesh_pg18_migration' "$REPLICATION_OBJECT_LOG" || {
  cat "$ERROR_LOG" >&2
  printf 'Teardown left the source publication in place.\n' >&2
  exit 1
}
if [[ -s "$ROLE_STATEMENT_LOG" ]]; then
  printf 'Teardown touched a role without the role variables exported.\n' >&2
  exit 1
fi

# 6. A still-present subscription is the one replication object whose ownership
# proof needs the role names, so that branch must refuse before any drop.
rm -f "$PUBLICATION_DROPPED_MARKER" "$SLOT_DROPPED_MARKER"
: >"$REPLICATION_OBJECT_LOG"
if FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 FAKE_SUBSCRIPTION_EXISTS=1 \
  run_teardown_without_role_variables >"$ERROR_LOG" 2>&1; then
  printf 'Expected a live subscription to require the role variables.\n' >&2
  exit 1
fi
grep -Fq 'Slot- and publication-only cleanup needs neither' "$ERROR_LOG" || {
  cat "$ERROR_LOG" >&2
  exit 1
}
if [[ -s "$REPLICATION_OBJECT_LOG" ]]; then
  printf 'Teardown dropped replication objects before proving subscription ownership.\n' >&2
  exit 1
fi

# 7. The same object state with both role names exported completes end to end.
rm -f "$PUBLICATION_DROPPED_MARKER" "$SLOT_DROPPED_MARKER"
: >"$REPLICATION_OBJECT_LOG"
: >"$ROLE_STATEMENT_LOG"
FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 FAKE_SUBSCRIBER_ROLE_COUNT=0 \
  run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected a fully-configured teardown of an orphan slot to succeed.\n' >&2
  exit 1
}
grep -Fq 'pg_drop_replication_slot' "$REPLICATION_OBJECT_LOG"
grep -Fq 'DROP PUBLICATION boardsesh_pg18_migration' "$REPLICATION_OBJECT_LOG"
grep -Fq "Temporary subscriber role 'boardsesh_pg18_subscriber' does not exist" "$ERROR_LOG"

assert_absent 'source:sec\ret' "$ARGUMENT_LOG" "$ERROR_LOG"
assert_absent 'target-secret' "$ARGUMENT_LOG" "$ERROR_LOG"
assert_absent 'publisher-secret' "$ARGUMENT_LOG" "$ERROR_LOG"

printf 'Replication helper keeps database passwords out of child argv and inherited xtrace.\n'
printf 'Teardown drops only an exact temporary subscriber role, idempotently.\n'
printf 'Teardown clears an orphan slot and publication without the role variables.\n'
