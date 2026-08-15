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
readonly FAILING_SQL="$MIGRATIONS_DIR/0000_fails.sql"
readonly JOURNAL_CREATED_AT=1734255307302
export PSQL_CALL_LOG

mkdir -p "$MIGRATIONS_DIR/meta" "$FAKE_BIN"
printf '%s\n' \
  "{\"entries\":[{\"tag\":\"0000_fails\",\"when\":$JOURNAL_CREATED_AT}]}" \
  >"$MIGRATIONS_DIR/meta/_journal.json"
printf '%s\n' 'SELECT definitely_invalid_syntax;' >"$FAILING_SQL"

cat >"$FAKE_BIN/psql" <<'FAKE_PSQL'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$PSQL_CALL_LOG"
for argument in "$@"; do
  if [[ "$argument" == "${FAIL_MIGRATION_FILE:-}" ]]; then
    exit 17
  fi
done
FAKE_PSQL
chmod +x "$FAKE_BIN/psql"

if PATH="$FAKE_BIN:$PATH" \
  DRIZZLE_MIGRATIONS_DIR="$MIGRATIONS_DIR" \
  FAIL_MIGRATION_FILE="$FAILING_SQL" \
  "$MIGRATION_SCRIPT" >"$TEST_ROOT/failure-output" 2>&1; then
  printf 'expected the deliberately failing migration to abort\n' >&2
  exit 1
fi
grep -Fq 'refusing to record it as applied' "$TEST_ROOT/failure-output"
if grep -Fq 'INSERT INTO' "$PSQL_CALL_LOG"; then
  printf 'a failing migration reached the ledger insert\n' >&2
  exit 1
fi

: >"$PSQL_CALL_LOG"
PATH="$FAKE_BIN:$PATH" \
  DRIZZLE_MIGRATIONS_DIR="$MIGRATIONS_DIR" \
  "$MIGRATION_SCRIPT" >/dev/null
[[ "$(grep -Fc 'INSERT INTO' "$PSQL_CALL_LOG")" -eq 2 ]]
[[ "$(grep -Fc "$JOURNAL_CREATED_AT" "$PSQL_CALL_LOG")" -eq 2 ]]

printf 'Dev-db migration fail-closed contract passed.\n'
