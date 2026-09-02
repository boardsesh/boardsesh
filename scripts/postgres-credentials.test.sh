#!/usr/bin/env bash
set -Eeuo pipefail

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-postgres-credentials.XXXXXX")"
readonly TEST_ROOT
trap 'rm -rf "$TEST_ROOT"' EXIT

readonly FAKE_BIN="$TEST_ROOT/bin"
readonly ARGUMENT_LOG="$TEST_ROOT/arguments.log"
readonly ENVIRONMENT_LOG="$TEST_ROOT/environment.log"
readonly TRACE_LOG="$TEST_ROOT/trace.log"
readonly ERROR_LOG="$TEST_ROOT/error.log"
readonly CREDENTIAL_DIRECTORY_LOG="$TEST_ROOT/credential-directory.log"
mkdir -p "$FAKE_BIN"
export ARGUMENT_LOG ENVIRONMENT_LOG CREDENTIAL_DIRECTORY_LOG

cat >"$FAKE_BIN/psql" <<'FAKE_PSQL'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'psql' >>"$ARGUMENT_LOG"
for argument in "$@"; do
  printf ' <%s>' "$argument" >>"$ARGUMENT_LOG"
done
printf '\n' >>"$ARGUMENT_LOG"
printf '%s|%s|%s|%s|%s|%s|%s|%s\n' \
  "$PGHOST" "$PGPORT" "$PGDATABASE" "$PGUSER" "$PGSSLMODE" "$PGSSLCERTMODE" \
  "$PGAPPNAME" "$PGOPTIONS" \
  >>"$ENVIRONMENT_LOG"
for inherited_name in PGREQUIRESSL PGDATESTYLE PGTZ PGGEQO PGGSSDELEGATION \
  PGMINPROTOCOLVERSION PGMAXPROTOCOLVERSION PGOAUTHDEBUG PGOAUTHCAFILE \
  PGSYSCONFDIR PGLOCALEDIR PGSERVICE PGSERVICEFILE PGHOSTADDR PGREPLICATION \
  BOARDSESH_LIBPQ_SOURCE_PASSWORD; do
  [[ -z "${!inherited_name+x}" ]]
done
[[ -f "$PGPASSFILE" ]]
[[ "$(stat -c '%a' "$PGPASSFILE" 2>/dev/null || stat -f '%Lp' "$PGPASSFILE")" == '600' ]]
grep -Fxq '2001\:db8\:\:1:5432:main\:db:source\:user:source\:sec\\ret' "$PGPASSFILE"
printf '%s\n' "${PGPASSFILE%/*}" >"$CREDENTIAL_DIRECTORY_LOG"
if [[ " $* " == *'to_regnamespace'* ]]; then
  printf '0\n'
elif [[ " $* " == *' SELECT current_database(); '* ]]; then
  printf 'main\n'
else
  printf 'public.example|0|digest\n'
fi
FAKE_PSQL
chmod +x "$FAKE_BIN/psql"

credential_uri='postgresql://source%3Auser:source%3Asec%5Cret@[2001:db8::1]/main%3Adb?sslmode=verify-full&sslcertmode=require&application_name=credential-test&options=-c%20search_path%3Dpublic'

PATH="$FAKE_BIN:$PATH" \
PGREQUIRESSL=1 \
PGDATESTYLE=poison \
PGTZ=poison \
PGGEQO=poison \
PGGSSDELEGATION=1 \
PGMINPROTOCOLVERSION=3.0 \
PGMAXPROTOCOLVERSION=3.0 \
PGOAUTHDEBUG=1 \
PGOAUTHCAFILE=/poison/oauth-ca.pem \
PGSYSCONFDIR=/poison \
PGLOCALEDIR=/poison \
PGSERVICE=poison \
PGSERVICEFILE=/poison \
PGHOSTADDR=203.0.113.9 \
PGREPLICATION=database \
BOARDSESH_LIBPQ_SOURCE_PASSWORD=inherited-export-poison \
SOURCE_DATABASE_URL="$credential_uri" \
TARGET_DATABASE_URL="$credential_uri" \
WRITES_FENCED=true \
EXPECTED_SOURCE_DATABASE=main \
EXPECTED_TARGET_DATABASE=main \
  bash -x "$PWD/scripts/postgres-migration-verify-data.sh" >/dev/null 2>"$TRACE_LOG"

[[ "$(grep -c '^psql' "$ARGUMENT_LOG")" == '6' ]]
grep -Fxq '2001:db8::1|5432|main:db|source:user|verify-full|require|credential-test|-c search_path=public -c default_transaction_read_only=on' \
  "$ENVIRONMENT_LOG"
if grep -Fq 'postgresql://' "$ARGUMENT_LOG"; then
  printf 'A database URI reached child argv.\n' >&2
  exit 1
fi
for secret_marker in 'source%3Asec%5Cret' 'source:sec\ret'; do
  if grep -Fq "$secret_marker" "$ARGUMENT_LOG" "$TRACE_LOG"; then
    printf 'A database password reached argv or inherited xtrace.\n' >&2
    exit 1
  fi
done
[[ ! -e "$(<"$CREDENTIAL_DIRECTORY_LOG")" ]]

# The audit, verification, and repair helpers must use the shared non-argv
# launcher. This guards against a future call site bypassing the tested transport.
if grep -nE 'psql[[:space:]]+"\$(ADMIN|SOURCE|TARGET|SOURCE_REPLICATION)_DATABASE_URL"|psql[[:space:]]+"\$connection_(url|uri)"' \
  "$PWD/scripts/postgres-migration-audit.sh" \
  "$PWD/scripts/postgres-migration-verify-data.sh" \
  "$PWD/scripts/postgres16-collation-repair.sh" >"$ERROR_LOG"; then
  cat "$ERROR_LOG" >&2
  exit 1
fi
grep -Fq 'boardsesh_run_libpq_connection' "$PWD/scripts/postgres-migration-audit.sh"
grep -Fq 'boardsesh_run_libpq_connection' "$PWD/scripts/postgres-migration-verify-data.sh"
grep -Fq 'boardsesh_run_libpq_connection' "$PWD/scripts/postgres16-collation-repair.sh"

if SOURCE_DATABASE_URL='postgresql://source:error-secret@source.example/main?pass%77ord=query-secret' \
  TARGET_DATABASE_URL='postgresql://target:target-secret@target.example/main' \
  WRITES_FENCED=true \
  EXPECTED_SOURCE_DATABASE=main \
  EXPECTED_TARGET_DATABASE=main \
  PATH="$FAKE_BIN:$PATH" \
    bash -x "$PWD/scripts/postgres-migration-verify-data.sh" >/dev/null 2>"$ERROR_LOG"; then
  printf 'Encoded password query option should fail closed.\n' >&2
  exit 1
fi
grep -Fq 'query option password would bypass validated URI fields' "$ERROR_LOG"
if grep -Fq 'error-secret' "$ERROR_LOG" || grep -Fq 'query-secret' "$ERROR_LOG" ||
  grep -Fq 'target-secret' "$ERROR_LOG"; then
  printf 'A rejected URL leaked through inherited xtrace/error output.\n' >&2
  exit 1
fi

# The subscription contract serializes the same validated fields as canonical
# libpq keyword conninfo. Exercise percent decoding and libpq quote/backslash
# escaping without ever passing the result through a child argv.
# shellcheck source=scripts/lib/postgres-credentials.sh
source "$PWD/scripts/lib/postgres-credentials.sh"
canonical_directory="$TEST_ROOT/canonical"
mkdir -m 0700 "$canonical_directory"
boardsesh_prepare_libpq_connection CANONICAL \
  "postgresql://user%27name:pa%27ss%5Cword@[2001:db8::2]/rail%3Away?sslmode=verify-full&sslcertmode=require&application_name=canonical-test" \
  "$canonical_directory"
boardsesh_write_libpq_conninfo CANONICAL "$canonical_directory/full" true
boardsesh_write_libpq_conninfo CANONICAL "$canonical_directory/redacted" false
expected_full="host='2001:db8::2' port='5432' dbname='rail:way' user='user\'name' password='pa\'ss\\\\word' application_name='canonical-test' sslcertmode='require' sslmode='verify-full' "
expected_redacted="host='2001:db8::2' port='5432' dbname='rail:way' user='user\'name' application_name='canonical-test' sslcertmode='require' sslmode='verify-full' "
[[ "$(<"$canonical_directory/full")" == "$expected_full" ]]
[[ "$(<"$canonical_directory/redacted")" == "$expected_redacted" ]]
[[ "$(stat -c '%a' "$canonical_directory/full" 2>/dev/null || stat -f '%Lp' "$canonical_directory/full")" == '600' ]]
boardsesh_md5_conninfo_file "$canonical_directory/full"
[[ "$REPLY" =~ ^[0-9a-f]{32}$ ]]
if grep -Fq 'password=' "$canonical_directory/redacted"; then
  printf 'Password appeared in redacted canonical conninfo.\n' >&2
  exit 1
fi

for encoded_host in 'source%2Cother' 'source%2Fsocket' 'source%20socket'; do
  if boardsesh_prepare_libpq_connection REJECTED_HOST \
    "postgresql://user:decoded-host-secret@${encoded_host}/railway" \
    "$canonical_directory" 2>"$ERROR_LOG"; then
    printf 'Decoded libpq host %s should have failed closed.\n' "$encoded_host" >&2
    exit 1
  fi
  grep -Fq 'decoded host cannot contain commas, slashes, or whitespace' "$ERROR_LOG"
  if grep -Fq 'decoded-host-secret' "$ERROR_LOG"; then
    printf 'Rejected decoded host leaked its password.\n' >&2
    exit 1
  fi
done

if MIGRATION_SCHEMAS='public public' \
  MIGRATION_EXCLUDED_SCHEMAS='public neon_auth' \
  SOURCE_DATABASE_URL='postgresql://source:source-secret@source.example/main' \
  TARGET_DATABASE_URL='postgresql://target:target-secret@target.example/main' \
  WRITES_FENCED=true \
  EXPECTED_SOURCE_DATABASE=main \
  EXPECTED_TARGET_DATABASE=main \
  PATH="$FAKE_BIN:$PATH" \
    bash "$PWD/scripts/postgres-migration-verify-data.sh" >/dev/null 2>"$ERROR_LOG"; then
  printf 'Overlapping/duplicate schema policies should fail before data verification.\n' >&2
  exit 1
fi
grep -Eq 'cannot appear in both|contains duplicate schema' "$ERROR_LOG"
if grep -Fq 'source-secret' "$ERROR_LOG" || grep -Fq 'target-secret' "$ERROR_LOG"; then
  printf 'A rejected schema policy leaked database credentials.\n' >&2
  exit 1
fi

if MIGRATION_SCHEMAS='public public' \
  MIGRATION_EXCLUDED_SCHEMAS='public neon_auth' \
  SOURCE_DATABASE_URL='postgresql://source:source-secret@source.example/main' \
  EXPECTED_SOURCE_DATABASE=main \
  PATH="$FAKE_BIN:$PATH" \
    bash "$PWD/scripts/postgres-migration-audit.sh" >/dev/null 2>"$ERROR_LOG"; then
  printf 'Overlapping/duplicate schema policies should fail before catalog audit.\n' >&2
  exit 1
fi
grep -Eq 'cannot appear in both|contains duplicate schema' "$ERROR_LOG"
if grep -Fq 'source-secret' "$ERROR_LOG"; then
  printf 'A rejected audit schema policy leaked database credentials.\n' >&2
  exit 1
fi

for adversarial_excluded_schemas in $'public\tneon_auth' $'public\nneon_auth'; do
  if MIGRATION_SCHEMAS='public' \
    MIGRATION_EXCLUDED_SCHEMAS="$adversarial_excluded_schemas" \
    SOURCE_DATABASE_URL='postgresql://source:source-secret@source.example/main' \
    TARGET_DATABASE_URL='postgresql://target:target-secret@target.example/main' \
    WRITES_FENCED=true \
    EXPECTED_SOURCE_DATABASE=main \
    EXPECTED_TARGET_DATABASE=main \
    PATH="$FAKE_BIN:$PATH" \
      bash "$PWD/scripts/postgres-migration-verify-data.sh" >/dev/null 2>"$ERROR_LOG"; then
    printf 'Whitespace-separated overlapping verifier schema policies should fail.\n' >&2
    exit 1
  fi
  grep -Fq 'cannot appear in both' "$ERROR_LOG"

  if MIGRATION_SCHEMAS='public' \
    MIGRATION_EXCLUDED_SCHEMAS="$adversarial_excluded_schemas" \
    SOURCE_DATABASE_URL='postgresql://source:source-secret@source.example/main' \
    EXPECTED_SOURCE_DATABASE=main \
    PATH="$FAKE_BIN:$PATH" \
      bash "$PWD/scripts/postgres-migration-audit.sh" >/dev/null 2>"$ERROR_LOG"; then
    printf 'Whitespace-separated overlapping audit schema policies should fail.\n' >&2
    exit 1
  fi
  grep -Fq 'cannot appear in both' "$ERROR_LOG"
done

printf 'Audit and data-verification libpq credentials stay out of argv and inherited xtrace.\n'
