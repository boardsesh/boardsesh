#!/usr/bin/env bash
set -Eeuo pipefail

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-migration-loop.XXXXXX")"
readonly TEST_ROOT
trap 'rm -rf "$TEST_ROOT"' EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly MIGRATION_SCRIPT="$SCRIPT_DIR/apply-drizzle-migrations.sh"
readonly MIGRATIONS_DIR="$TEST_ROOT/drizzle"
readonly FAKE_BIN="$TEST_ROOT/bin"
readonly PSQL_CALL_LOG="$TEST_ROOT/psql-calls"
readonly PSQL_TRANSACTION_LOG="$TEST_ROOT/psql-transactions"
readonly PSQL_COMMIT_LOG="$TEST_ROOT/psql-commits"
readonly TRANSACTION_SQL="$MIGRATIONS_DIR/0000_transaction_contract.sql"
readonly JOURNAL_CREATED_AT=1734255307302
export PSQL_CALL_LOG PSQL_TRANSACTION_LOG PSQL_COMMIT_LOG JOURNAL_CREATED_AT

mkdir -p "$MIGRATIONS_DIR/meta" "$FAKE_BIN"
printf '%s\n' \
  "{\"entries\":[{\"tag\":\"0000_transaction_contract\",\"when\":$JOURNAL_CREATED_AT}]}" \
  >"$MIGRATIONS_DIR/meta/_journal.json"
cat >"$TRANSACTION_SQL" <<'SQL'
CREATE TEMP TABLE migration_contract_temp ON COMMIT DROP AS SELECT 42 AS id;
CREATE TABLE migration_contract_effect AS
SELECT id FROM migration_contract_temp;
SQL

# Model the psql CLI contract without needing a database for the fast shell
# test. The live PostgreSQL image smoke below proves the actual commit/rollback
# behavior against PostgreSQL 18.
cat >"$FAKE_BIN/psql" <<'FAKE_PSQL'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$PSQL_CALL_LOG"

migration_file=''
single_transaction=false
ledger_insert_count=0
journal_timestamp_count=0
ledger_order=''

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --single-transaction)
      single_transaction=true
      ;;
    -f)
      shift
      [[ "$#" -gt 0 ]] || exit 90
      migration_file="$1"
      ;;
    -c)
      shift
      [[ "$#" -gt 0 ]] || exit 91
      sql_command="$1"
      if [[ "$sql_command" == INSERT\ INTO* ]]; then
        [[ -n "$migration_file" ]] || exit 92
        ledger_insert_count=$((ledger_insert_count + 1))
        [[ "$sql_command" == *"$JOURNAL_CREATED_AT"* ]] &&
          journal_timestamp_count=$((journal_timestamp_count + 1))
        if [[ "$sql_command" == 'INSERT INTO "__drizzle_migrations"'* ]]; then
          ledger_name=public
        elif [[ "$sql_command" == 'INSERT INTO drizzle."__drizzle_migrations"'* ]]; then
          ledger_name=drizzle
        else
          exit 93
        fi
        ledger_order="${ledger_order:+$ledger_order,}$ledger_name"
      fi
      ;;
  esac
  shift
done

if [[ -n "$migration_file" ]]; then
  printf '%s|%s|%s|%s|%s\n' \
    "$migration_file" "$single_transaction" "$ledger_insert_count" \
    "$journal_timestamp_count" "$ledger_order" >>"$PSQL_TRANSACTION_LOG"
  [[ "$single_transaction" == true ]] || exit 94
  [[ "$ledger_insert_count" -eq 2 ]] || exit 95
  [[ "$journal_timestamp_count" -eq 2 ]] || exit 96
  [[ "$ledger_order" == 'public,drizzle' ]] || exit 97

  [[ "$migration_file" != "${FAIL_MIGRATION_FILE:-}" ]] || exit 17
  [[ "${FAIL_SECOND_LEDGER:-false}" != true ]] || exit 18
  printf '%s\n' "$migration_file" >>"$PSQL_COMMIT_LOG"
fi
FAKE_PSQL
chmod +x "$FAKE_BIN/psql"

readonly EXPECTED_TRANSACTION="$TRANSACTION_SQL|true|2|2|public,drizzle"

if PATH="$FAKE_BIN:$PATH" \
  DRIZZLE_MIGRATIONS_DIR="$MIGRATIONS_DIR" \
  FAIL_MIGRATION_FILE="$TRANSACTION_SQL" \
  "$MIGRATION_SCRIPT" >"$TEST_ROOT/migration-failure-output" 2>&1; then
  printf 'expected the deliberately failing migration to abort\n' >&2
  exit 1
fi
grep -Fq 'schema and ledger changes were rolled back' "$TEST_ROOT/migration-failure-output"
[[ "$(<"$PSQL_TRANSACTION_LOG")" == "$EXPECTED_TRANSACTION" ]]
[[ ! -s "$PSQL_COMMIT_LOG" ]]

: >"$PSQL_CALL_LOG"
: >"$PSQL_TRANSACTION_LOG"
: >"$PSQL_COMMIT_LOG"
if PATH="$FAKE_BIN:$PATH" \
  DRIZZLE_MIGRATIONS_DIR="$MIGRATIONS_DIR" \
  FAIL_SECOND_LEDGER=true \
  "$MIGRATION_SCRIPT" >"$TEST_ROOT/ledger-failure-output" 2>&1; then
  printf 'expected a second-ledger failure to abort the migration transaction\n' >&2
  exit 1
fi
grep -Fq 'schema and ledger changes were rolled back' "$TEST_ROOT/ledger-failure-output"
[[ "$(<"$PSQL_TRANSACTION_LOG")" == "$EXPECTED_TRANSACTION" ]]
[[ ! -s "$PSQL_COMMIT_LOG" ]]

: >"$PSQL_CALL_LOG"
: >"$PSQL_TRANSACTION_LOG"
: >"$PSQL_COMMIT_LOG"
PATH="$FAKE_BIN:$PATH" \
  DRIZZLE_MIGRATIONS_DIR="$MIGRATIONS_DIR" \
  "$MIGRATION_SCRIPT" >/dev/null
[[ "$(<"$PSQL_TRANSACTION_LOG")" == "$EXPECTED_TRANSACTION" ]]
[[ "$(<"$PSQL_COMMIT_LOG")" == "$TRANSACTION_SQL" ]]

printf 'Dev-db migration atomicity contract passed.\n'
