#!/usr/bin/env bash
set -Eeuo pipefail

readonly MIGRATIONS_DIR="${DRIZZLE_MIGRATIONS_DIR:-/drizzle}"
readonly JOURNAL_FILE="$MIGRATIONS_DIR/meta/_journal.json"

fail() {
  printf 'boardsesh-dev-db migrations: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail 'jq is required'
command -v psql >/dev/null 2>&1 || fail 'psql is required'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
[[ -f "$JOURNAL_FILE" ]] || fail "journal is missing: $JOURNAL_FILE"

migration_count="$(jq -er '.entries | length' "$JOURNAL_FILE")"
[[ "$migration_count" =~ ^[0-9]+$ ]] || fail 'journal migration count is invalid'
printf '  Found %s migrations in journal\n' "$migration_count"

psql -X -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)'
psql -X -v ON_ERROR_STOP=1 -c 'CREATE SCHEMA IF NOT EXISTS drizzle'
psql -X -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)'

applied=0
# Preserve each journal `when` exactly. The repository contains legacy entries
# that are not globally time-sorted, so image-build time is not a safe substitute.
while IFS=$'\t' read -r tag journal_created_at; do
  [[ "$tag" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "invalid migration tag: $tag"
  [[ "$journal_created_at" =~ ^[0-9]+$ ]] || fail "invalid journal timestamp: $tag"
  sql_file="$MIGRATIONS_DIR/${tag}.sql"
  [[ -f "$sql_file" ]] || fail "migration file is missing: $sql_file"

  hash="$(sha256sum "$sql_file" | cut -d' ' -f1)"
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || fail "could not hash migration: $tag"
  applied=$((applied + 1))
  printf '  [%s/%s] Applying: %s\n' "$applied" "$migration_count" "$tag"

  # One psql process and transaction are required for migrations that use
  # transaction-scoped state such as CREATE TEMP TABLE ... ON COMMIT DROP.
  # Keeping both ledger writes in that transaction also prevents applied DDL
  # from being committed when either ledger insert fails.
  if ! psql -X -v ON_ERROR_STOP=1 --single-transaction \
    -f "$sql_file" \
    -c "INSERT INTO \"__drizzle_migrations\" (hash, created_at) VALUES ('$hash', $journal_created_at)" \
    -c "INSERT INTO drizzle.\"__drizzle_migrations\" (hash, created_at) VALUES ('$hash', $journal_created_at)"; then
    fail "migration $tag failed; its schema and ledger changes were rolled back"
  fi
done < <(jq -er '.entries[] | [.tag, .when] | @tsv' "$JOURNAL_FILE")

[[ "$applied" -eq "$migration_count" ]] ||
  fail "journal listed $migration_count migrations but $applied tags were read"
printf '>>> All %s migrations applied successfully.\n' "$applied"
