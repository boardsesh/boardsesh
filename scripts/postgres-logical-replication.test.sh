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
# Slot drops are recorded by name as well as by statement text: the helper drops
# the migration slot and any stranded table-synchronization slot through the same
# statement, so only the -v slot_name it passed tells them apart.
readonly SLOT_DROP_NAME_LOG="$TEST_ROOT/slot-drop-names.log"
export ARGUMENT_LOG CLEANUP_PATH_LOG SUBSCRIPTION_FILE_CHECK HYPOPG_CREATE_MARKER \
  ROLE_STATEMENT_LOG SUBSCRIBER_DROPPED_MARKER REPLICATION_OBJECT_LOG \
  PUBLICATION_DROPPED_MARKER SLOT_DROPPED_MARKER SUBSCRIPTION_DROPPED_MARKER \
  SLOT_DROP_NAME_LOG
mkdir -p "$FAKE_BIN"
: >"$SLOT_DROP_NAME_LOG"

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
# Real psql substitutes :'name' server-side, so the captured statement text never
# carries the value. Keep the two the helper varies per call.
psql_variable_slot_name=''
psql_variable_subscription_oid=''
for argument in "$@"; do
  if [[ "$expect_sql" == true ]]; then
    sql="$argument"
    expect_sql=false
  elif [[ "$argument" == '-c' || "$argument" == '--command' || "$argument" =~ ^-[A-Za-z]*c[A-Za-z]*$ ]]; then
    expect_sql=true
  fi
  if [[ "$previous_argument" == '-v' || "$previous_argument" == '--set' ]]; then
    case "$argument" in
      slot_name=*) psql_variable_slot_name="${argument#slot_name=}" ;;
      subscription_oid=*) psql_variable_subscription_oid="${argument#subscription_oid=}" ;;
    esac
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
  printf '%s\n' "$psql_variable_slot_name" >>"$SLOT_DROP_NAME_LOG"
  # Only the migration slot drives the simulated existence probes. Sync slots
  # come and go by name through SLOT_DROP_NAME_LOG.
  if [[ "$psql_variable_slot_name" == 'boardsesh_pg18_migration' ]]; then
    : >"$SLOT_DROPPED_MARKER"
  fi
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
  *"format('%s|%s', subscription.oid"*)
    # Teardown's pre-drop identity probe. FAKE_SUBSCRIPTION_SLOT_NAME expands
    # with ${VAR-default}, not ${VAR:-default}, on purpose: set-but-empty is the
    # detached subscription (subslotname NULL) a run interrupted after
    # SET (slot_name = NONE) leaves behind, and :- would erase that case.
    printf '%s|%s\n' "${FAKE_SUBSCRIPTION_OID:-16452}" \
      "${FAKE_SUBSCRIPTION_SLOT_NAME-boardsesh_pg18_migration}"
    ;;
  *'FROM pg_subscription AS subscription'*)
    # Evaluate the emitted subscription contract against a simulated catalog row
    # rather than answering 't' unconditionally. Teardown's relaxation is a
    # change to this query's predicates, so reading the SQL the helper actually
    # sent is the only way a test can prove which call site relaxed what.
    simulated_slot_name="${FAKE_SUBSCRIPTION_SLOT_NAME-boardsesh_pg18_migration}"
    contract_verdict=t
    if [[ "$sql" == *'AND subscription.subenabled'* && "${FAKE_SUBSCRIPTION_ENABLED:-t}" != 't' ]]; then
      contract_verdict=f
    fi
    if [[ -n "$simulated_slot_name" ]]; then
      [[ "$sql" == *"subscription.subslotname = '${simulated_slot_name}'"* ]] || contract_verdict=f
    else
      [[ "$sql" == *'subscription.subslotname IS NULL'* ]] || contract_verdict=f
    fi
    [[ "$sql" == *"pg_get_userbyid(subscription.subowner) = '${FAKE_SUBSCRIPTION_OWNER:-boardsesh_pg18_subscriber}'"* ]] ||
      contract_verdict=f
    [[ "$sql" == *"subscription.subpublications = ARRAY['${FAKE_SUBSCRIPTION_PUBLICATION:-boardsesh_pg18_migration}']::text[]"* ]] ||
      contract_verdict=f
    # The two connection predicates are checked for presence as well as
    # simulated, unlike the knobs above. They are the half of the identity proof
    # no other test exercises -- the live-PostgreSQL decoy in
    # scripts/postgres18-image-smoke.sh also differs in owner and origin -- so
    # without this, deleting them from the helper would pass the whole suite.
    [[ "$sql" == *"md5(subscription.subconninfo) = '"* ]] || contract_verdict=f
    [[ "$sql" == *"obj_description(subscription.oid, 'pg_subscription') ="* &&
      "$sql" == *"'boardsesh-pg18-conninfo-v1:"* ]] || contract_verdict=f
    [[ "${FAKE_SUBSCRIPTION_CONNINFO_MATCHES:-t}" == 't' ]] || contract_verdict=f
    printf '%s\n' "$contract_verdict"
    ;;
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
  *'FROM pg_stat_replication AS replication'*)
    # Teardown's pre-mutation slot contract, evaluated against a simulated slot
    # the same way the subscription contract arm is: by reading the predicates
    # the helper actually emitted. FAKE_SLOT_ACTIVE=1 is our own walsender still
    # attached, which is what a run that exhausted the release budget leaves
    # behind once the subscription is gone; 'foreign' is somebody else holding a
    # same-named slot, which must never be tolerated.
    slot_contract_verdict=t
    if [[ "${FAKE_SLOT_ACTIVE:-0}" != '0' ]]; then
      slot_contract_verdict=f
      if [[ "${FAKE_SLOT_ACTIVE}" == '1' &&
        "$sql" == *"replication.application_name = :'subscription_name'"* &&
        "$sql" != *"subscription_exists' = 'true'"* ]]; then
        slot_contract_verdict=t
      fi
    fi
    printf '%s\n' "$slot_contract_verdict"
    ;;
  *"CASE WHEN slot.active THEN 'held'"*)
    # The release poll. 'gone' simulates a second operator dropping the slot
    # mid-wait, so mark it dropped too: the verification afterwards has to see it
    # absent rather than blame a walsender that is no longer there.
    if [[ "${FAKE_SLOT_RELEASE_STATE:-released}" == 'gone' ]]; then
      : >"$SLOT_DROPPED_MARKER"
    fi
    printf '%s\n' "${FAKE_SLOT_RELEASE_STATE:-released}"
    ;;
  *"~ '^pg_[0-9]+_sync_"*)
    # The orphan-path probe: sync slots that survive with no subscription left to
    # attribute them to. Must be answered above the OID-scoped arm below, whose
    # pattern its own text would otherwise match.
    printf '%s\n' ${FAKE_UNATTRIBUTED_TABLESYNC_SLOTS:-}
    ;;
  *'_sync_[0-9]+'*)
    # Stranded table-synchronization slots on the source. Answered only when the
    # helper passed the subscription OID it read from the target catalogue *and*
    # built the name pattern out of it, so neither a sweep aimed at the wrong
    # subscription nor one widened to every subscription's sync slots can pass.
    if [[ "$psql_variable_subscription_oid" == "${FAKE_SUBSCRIPTION_OID:-16452}" &&
      "$sql" == *":'subscription_oid'"* ]]; then
      for simulated_tablesync_slot in ${FAKE_TABLESYNC_SLOTS:-}; do
        if [[ "${FAKE_TABLESYNC_SLOTS_PERSIST:-0}" == '1' ]] ||
          ! grep -Fxq "$simulated_tablesync_slot" "$SLOT_DROP_NAME_LOG"; then
          printf '%s\n' "$simulated_tablesync_slot"
        fi
      done
    fi
    ;;
  *'FROM pg_replication_slots'*)
    # Keep this arm last of the four: it matches every slot query, and the three
    # above are the specific ones. The contract probes only run once the slot is
    # known to exist, so they always answer "matches"; the count probes track the
    # simulated drop.
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

# The remaining teardown cases all start from the same object state -- subscription,
# publication and slot all present -- and vary only the simulated pg_subscription
# row. Reset the drop markers so each run meets that state again.
reset_replication_object_state() {
  rm -f "$SUBSCRIPTION_DROPPED_MARKER" "$PUBLICATION_DROPPED_MARKER" "$SLOT_DROPPED_MARKER"
  : >"$REPLICATION_OBJECT_LOG"
  : >"$ROLE_STATEMENT_LOG"
  : >"$SLOT_DROP_NAME_LOG"
}

# Every refusal is asserted twice: teardown has to exit non-zero *and* say why.
# A bare "expected this to fail" would also pass if the helper were missing and
# bash exited 127 without ever reading the catalog.
assert_teardown_refuses() {
  local expected_message="$1"
  reset_replication_object_state
  if run_teardown >"$ERROR_LOG" 2>&1; then
    printf 'Expected teardown to refuse this subscription: %s\n' "$expected_message" >&2
    exit 1
  fi
  grep -Fq "$expected_message" "$ERROR_LOG" || {
    cat "$ERROR_LOG" >&2
    printf 'Teardown refused for the wrong reason; expected: %s\n' "$expected_message" >&2
    exit 1
  }
  if [[ -s "$REPLICATION_OBJECT_LOG" ]]; then
    cat "$REPLICATION_OBJECT_LOG" >&2
    printf 'Teardown dropped a replication object before refusing.\n' >&2
    exit 1
  fi
}

assert_teardown_cleared_every_replication_object() {
  local failure_note="$1"
  local expected_statement
  for expected_statement in 'DROP SUBSCRIPTION boardsesh_pg18_sub;' 'pg_drop_replication_slot' \
    'DROP PUBLICATION boardsesh_pg18_migration'; do
    grep -Fq "$expected_statement" "$REPLICATION_OBJECT_LOG" || {
      cat "$ERROR_LOG" "$REPLICATION_OBJECT_LOG" >&2
      printf '%s: %s was never issued.\n' "$failure_note" "$expected_statement" >&2
      exit 1
    }
  done
}

# 8. Issue #4513. DROP SUBSCRIPTION has to reach the publisher to drop the remote
# slot, so the publisher outage that sent the operator to teardown commits the
# DISABLE and fails the DROP. The next run meets a disabled subscription and has
# to finish the job rather than refuse on subenabled while the source fills.
reset_replication_object_state
FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
  FAKE_SUBSCRIPTION_ENABLED=f \
  run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected teardown to drop a disabled subscription.\n' >&2
  exit 1
}
assert_teardown_cleared_every_replication_object 'Teardown of a disabled subscription'

# The drop disables, then detaches, then drops, in that order: a detached
# DROP SUBSCRIPTION never contacts the unreachable publisher, and PostgreSQL
# only accepts slot_name = NONE while the subscription is disabled.
teardown_subscription_statements="$(tr '\n' ' ' <"$REPLICATION_OBJECT_LOG" | tr -s ' ')"
[[ "$teardown_subscription_statements" == *'ALTER SUBSCRIPTION boardsesh_pg18_sub DISABLE; ALTER SUBSCRIPTION boardsesh_pg18_sub SET (slot_name = NONE); DROP SUBSCRIPTION boardsesh_pg18_sub;'* ]] || {
  cat "$REPLICATION_OBJECT_LOG" >&2
  printf 'Teardown did not disable, detach, then drop the subscription in that order.\n' >&2
  exit 1
}

# 9. The same run interrupted one statement later: SET (slot_name = NONE)
# committed, the DROP did not, so subslotname is NULL. The slot is still on the
# source, still retaining WAL, and teardown owns removing it.
reset_replication_object_state
FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
  FAKE_SUBSCRIPTION_ENABLED=f FAKE_SUBSCRIPTION_SLOT_NAME='' \
  run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected teardown to drop a subscription whose slot is already detached.\n' >&2
  exit 1
}
assert_teardown_cleared_every_replication_object 'Teardown of a detached subscription'

# 10. Detached, and the orphan slot already dropped by hand during the emergency.
# The subscription and publication still have to go.
reset_replication_object_state
FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=0 \
  FAKE_SUBSCRIPTION_ENABLED=f FAKE_SUBSCRIPTION_SLOT_NAME='' \
  run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected teardown to finish once the detached subscription lost its slot.\n' >&2
  exit 1
}
grep -Fq 'DROP SUBSCRIPTION boardsesh_pg18_sub;' "$REPLICATION_OBJECT_LOG" || {
  cat "$ERROR_LOG" "$REPLICATION_OBJECT_LOG" >&2
  printf 'Teardown left a detached subscription in place.\n' >&2
  exit 1
}
grep -Fq 'DROP PUBLICATION boardsesh_pg18_migration' "$REPLICATION_OBJECT_LOG" || {
  cat "$ERROR_LOG" "$REPLICATION_OBJECT_LOG" >&2
  printf 'Teardown left the source publication in place.\n' >&2
  exit 1
}

# 11. The same missing slot with the subscription still attached to it is not the
# resumable case; it means these names do not describe one migration. The
# detached exception above must not have weakened that.
FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=0 \
  assert_teardown_refuses 'exists without source slot boardsesh_pg18_migration; refusing teardown'

# 12. Identity still has to be proven. Relaxing subenabled and subslotname leaves
# subname, subowner, subpublications, the conninfo digest and the digest comment
# carrying it, so a same-named subscription that fails any of them is refused --
# and refused whether it is enabled, disabled, or already detached.
readonly SUBSCRIPTION_CONTRACT_REFUSAL='does not match the exact owner/options/publication/slot/canonical connection contract'
for simulated_slot_state in boardsesh_pg18_migration ''; do
  for simulated_enabled_state in t f; do
    FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
      FAKE_SUBSCRIPTION_SLOT_NAME="$simulated_slot_state" \
      FAKE_SUBSCRIPTION_ENABLED="$simulated_enabled_state" \
      FAKE_SUBSCRIPTION_OWNER=somebody_elses_role \
      assert_teardown_refuses "$SUBSCRIPTION_CONTRACT_REFUSAL"
    FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
      FAKE_SUBSCRIPTION_SLOT_NAME="$simulated_slot_state" \
      FAKE_SUBSCRIPTION_ENABLED="$simulated_enabled_state" \
      FAKE_SUBSCRIPTION_PUBLICATION=somebody_elses_publication \
      assert_teardown_refuses "$SUBSCRIPTION_CONTRACT_REFUSAL"
    FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
      FAKE_SUBSCRIPTION_SLOT_NAME="$simulated_slot_state" \
      FAKE_SUBSCRIPTION_ENABLED="$simulated_enabled_state" \
      FAKE_SUBSCRIPTION_CONNINFO_MATCHES=f \
      assert_teardown_refuses "$SUBSCRIPTION_CONTRACT_REFUSAL"
  done
done

# A subscription pointing at some other slot is not detached, and the OR that
# admits NULL must not have turned into "any slot name will do".
FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
  FAKE_SUBSCRIPTION_SLOT_NAME=somebody_elses_slot \
  assert_teardown_refuses "$SUBSCRIPTION_CONTRACT_REFUSAL"

# 13. Only teardown asked for the relaxation. status, setup and sync-sequences
# read a subscription they expect to be replicating, and a disabled or detached
# one means the migration is not in the state they are about to report on.
run_status() {
  PATH="$FAKE_BIN:$PATH" \
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
    bash "$PWD/scripts/postgres-logical-replication.sh" status
}

# The control run proves the case below fails on the simulated row rather than on
# a status command that was already broken.
run_status >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected status to accept an enabled subscription with its slot attached.\n' >&2
  exit 1
}

for rejected_subscription_state in disabled detached; do
  case "$rejected_subscription_state" in
    disabled) simulated_enabled_state=f simulated_slot_state=boardsesh_pg18_migration ;;
    detached) simulated_enabled_state=t simulated_slot_state='' ;;
  esac
  if FAKE_SUBSCRIPTION_ENABLED="$simulated_enabled_state" \
    FAKE_SUBSCRIPTION_SLOT_NAME="$simulated_slot_state" \
    run_status >"$ERROR_LOG" 2>&1; then
    printf 'Expected status to reject a %s subscription.\n' "$rejected_subscription_state" >&2
    exit 1
  fi
  grep -Fq "$SUBSCRIPTION_CONTRACT_REFUSAL" "$ERROR_LOG" || {
    cat "$ERROR_LOG" >&2
    printf 'status rejected the %s subscription for the wrong reason.\n' "$rejected_subscription_state" >&2
    exit 1
  }
done

# 14. Detaching the slot means DROP SUBSCRIPTION never contacts the publisher, so
# it no longer cleans up after an unfinished initial copy either. One
# table-synchronization slot per unsynchronized table is left holding WAL with
# nothing but this sweep to remove it. The fake answers only when the helper
# passes the subscription OID it read before the drop, so this also pins that the
# sweep is aimed at this migration's subscription rather than at a wildcard.
reset_replication_object_state
FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
  FAKE_SUBSCRIPTION_OID=24680 \
  FAKE_TABLESYNC_SLOTS='pg_24680_sync_16400_74921 pg_24680_sync_16401_74921' \
  run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected teardown to sweep the stranded table-synchronization slots.\n' >&2
  exit 1
}
assert_teardown_cleared_every_replication_object 'Teardown with stranded sync slots'
for expected_dropped_slot in boardsesh_pg18_migration pg_24680_sync_16400_74921 pg_24680_sync_16401_74921; do
  grep -Fxq "$expected_dropped_slot" "$SLOT_DROP_NAME_LOG" || {
    cat "$ERROR_LOG" "$SLOT_DROP_NAME_LOG" >&2
    printf 'Teardown left %s retaining WAL on the source.\n' "$expected_dropped_slot" >&2
    exit 1
  }
done

# 15. A sync slot that survives the sweep means the source is still filling, so
# teardown has to say so instead of exiting clean. A silent all-clear over a
# retained slot is the failure #4513 is about.
reset_replication_object_state
if FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
  FAKE_SUBSCRIPTION_OID=24680 \
  FAKE_TABLESYNC_SLOTS='pg_24680_sync_16400_74921' FAKE_TABLESYNC_SLOTS_PERSIST=1 \
  run_teardown >"$ERROR_LOG" 2>&1; then
  printf 'Expected teardown to fail on a table-synchronization slot it could not remove.\n' >&2
  exit 1
fi
grep -Fq 'still exist after teardown and keep retaining WAL' "$ERROR_LOG" || {
  cat "$ERROR_LOG" >&2
  printf 'Teardown failed for the wrong reason on an unremovable sync slot.\n' >&2
  exit 1
}

# 16. The publisher releases a slot only once its walsender notices the closed
# connection, so teardown waits. Budget exhausted, it must stop with the catalog
# untouched -- and name the walsender, because the operator's next move is to
# wait, not to go hunting for a contract mismatch.
reset_replication_object_state
if FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
  FAKE_SLOT_RELEASE_STATE=held SOURCE_SLOT_RELEASE_SECONDS=0 \
  run_teardown >"$ERROR_LOG" 2>&1; then
  printf 'Expected teardown to stop while a walsender still held the source slot.\n' >&2
  exit 1
fi
grep -Fq 'is still held by an active walsender' "$ERROR_LOG" || {
  cat "$ERROR_LOG" >&2
  printf 'Teardown failed for the wrong reason while the slot was held.\n' >&2
  exit 1
}
if [[ -s "$SLOT_DROP_NAME_LOG" ]]; then
  cat "$SLOT_DROP_NAME_LOG" >&2
  printf 'Teardown dropped a slot that was still held by a walsender.\n' >&2
  exit 1
fi

# 17. The same poll must not confuse "already gone" with "still held". A second
# operator dropping the slot mid-wait is the outcome teardown wanted; spending
# the whole budget and then blaming a walsender that is not there sends the next
# responder after the wrong thing.
reset_replication_object_state
FAKE_SUBSCRIPTION_EXISTS=1 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
  FAKE_SLOT_RELEASE_STATE=gone SOURCE_SLOT_RELEASE_SECONDS=0 \
  run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected teardown to finish when the source slot vanished mid-wait.\n' >&2
  exit 1
}
grep -Fq "Source slot 'boardsesh_pg18_migration' was already gone" "$ERROR_LOG" || {
  cat "$ERROR_LOG" >&2
  printf 'Teardown did not report the slot as already gone.\n' >&2
  exit 1
}
grep -Fq 'DROP SUBSCRIPTION boardsesh_pg18_sub;' "$REPLICATION_OBJECT_LOG"
grep -Fq 'DROP PUBLICATION boardsesh_pg18_migration' "$REPLICATION_OBJECT_LOG"
if [[ -s "$SLOT_DROP_NAME_LOG" ]]; then
  cat "$SLOT_DROP_NAME_LOG" >&2
  printf 'Teardown dropped a slot that was already gone.\n' >&2
  exit 1
fi

# 18. The state a budget-exhausted run leaves for its own re-run: subscription
# already dropped, our walsender still attached to the slot for as long as the
# source's wal_sender_timeout. The pre-mutation slot contract has to read that as
# "wait", not as "this slot is not yours".
reset_replication_object_state
FAKE_SUBSCRIPTION_EXISTS=0 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=1 \
  FAKE_SLOT_ACTIVE=1 \
  run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected the re-run after an exhausted release budget to finish the slot.\n' >&2
  exit 1
}
grep -Fxq 'boardsesh_pg18_migration' "$SLOT_DROP_NAME_LOG" || {
  cat "$ERROR_LOG" "$SLOT_DROP_NAME_LOG" >&2
  printf 'The re-run left the WAL-retaining slot in place.\n' >&2
  exit 1
}

# ...and that tolerance is still attribution-gated. An active slot held by
# anything that does not announce itself as this subscription is refused, with or
# without a subscription left to compare it against.
for simulated_subscription_presence in 0 1; do
  reset_replication_object_state
  if FAKE_SUBSCRIPTION_EXISTS="$simulated_subscription_presence" FAKE_PUBLICATION_EXISTS=1 \
    FAKE_SLOT_EXISTS=1 FAKE_SLOT_ACTIVE=foreign \
    run_teardown >"$ERROR_LOG" 2>&1; then
    printf 'Expected teardown to refuse a source slot held by a foreign walsender.\n' >&2
    exit 1
  fi
  grep -Fq 'does not match the exact logical pgoutput/current-database/subscription contract' "$ERROR_LOG" || {
    cat "$ERROR_LOG" >&2
    printf 'Teardown refused the foreign-walsender slot for the wrong reason.\n' >&2
    exit 1
  }
  if [[ -s "$REPLICATION_OBJECT_LOG" ]]; then
    cat "$REPLICATION_OBJECT_LOG" >&2
    printf 'Teardown dropped a replication object before refusing a foreign walsender.\n' >&2
    exit 1
  fi
done

# 19. A run that dies on the walsender wait has already dropped the subscription,
# so its re-run has no OID left to attribute sync slots with. Teardown will not
# drop what it cannot attribute -- another subscriber on this source database
# makes identical-looking names -- but exiting clean without mentioning them
# would hide exactly the WAL retention this whole change is about.
reset_replication_object_state
FAKE_SUBSCRIPTION_EXISTS=0 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=0 \
  FAKE_UNATTRIBUTED_TABLESYNC_SLOTS='pg_31337_sync_16400_74921' \
  run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected teardown to finish over sync slots it cannot attribute.\n' >&2
  exit 1
}
grep -Fq 'cannot attribute to any subscription' "$ERROR_LOG" || {
  cat "$ERROR_LOG" >&2
  printf 'Teardown said nothing about the unattributable sync slots it left retaining WAL.\n' >&2
  exit 1
}
grep -Fq 'pg_31337_sync_16400_74921' "$ERROR_LOG" || {
  cat "$ERROR_LOG" >&2
  printf 'Teardown did not name the sync slots it left behind.\n' >&2
  exit 1
}
if [[ -s "$SLOT_DROP_NAME_LOG" ]]; then
  cat "$SLOT_DROP_NAME_LOG" >&2
  printf 'Teardown dropped a slot it could not attribute to this migration.\n' >&2
  exit 1
fi

# The same run with nothing stranded must stay quiet, or the warning is noise
# every operator learns to scroll past.
reset_replication_object_state
FAKE_SUBSCRIPTION_EXISTS=0 FAKE_PUBLICATION_EXISTS=1 FAKE_SLOT_EXISTS=0 \
  run_teardown >"$ERROR_LOG" 2>&1 || {
  cat "$ERROR_LOG" >&2
  printf 'Expected a teardown with nothing stranded to succeed.\n' >&2
  exit 1
}
if grep -Fq 'cannot attribute to any subscription' "$ERROR_LOG"; then
  cat "$ERROR_LOG" >&2
  printf 'Teardown warned about sync slots that do not exist.\n' >&2
  exit 1
fi

assert_absent 'source:sec\ret' "$ARGUMENT_LOG" "$ERROR_LOG"
assert_absent 'target-secret' "$ARGUMENT_LOG" "$ERROR_LOG"
assert_absent 'publisher-secret' "$ARGUMENT_LOG" "$ERROR_LOG"

printf 'Replication helper keeps database passwords out of child argv and inherited xtrace.\n'
printf 'Teardown drops only an exact temporary subscriber role, idempotently.\n'
printf 'Teardown clears an orphan slot and publication without the role variables.\n'
printf 'Teardown drops a disabled or slot-detached subscription without weakening its identity contract.\n'
printf 'Teardown clears the sync slots a detached drop leaves behind, and waits out the publisher walsender.\n'
