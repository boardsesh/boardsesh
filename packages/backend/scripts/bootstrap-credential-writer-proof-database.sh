#!/usr/bin/env bash
set -Eeuo pipefail

historical_profile=false
if [[ "$#" = 1 && "${1:-}" = --historical-private-browser-v1 ]]; then
  historical_profile=true
elif [[ "$#" != 0 ]]; then
  printf 'Credential writer proof accepts only its fixed historical profile option\n' >&2
  exit 1
fi

# A validated URL must not coexist with a libpq redirect or a session override.
# TLS/client options remain available; routing and role/search_path overrides do not.
for routing_override in PGHOSTADDR PGSERVICE PGSERVICEFILE PGSYSCONFDIR PGOPTIONS; do
  [[ -z "${!routing_override:-}" ]] || {
    printf 'Credential writer proof refuses inherited %s\n' "$routing_override" >&2
    exit 1
  }
done

# Fresh disposable proof databases only. Never accepts the seeded dev/main DB.
[[ "${PGHOST:-}" = 127.0.0.1 || "${PGHOST:-}" = localhost ]] || exit 1
if [[ "${PGPORT:-}" = 55480 && "${PGDATABASE:-}" =~ ^epic6975_credential_[0-9]{8}$ ]]; then
  :
elif [[ "${CI:-}" = true && "${GITHUB_ACTIONS:-}" = true && "${PGPORT:-}" = 5432 \
    && ( ( "$historical_profile" = false && "${PGDATABASE:-}" = epic6975_credential_ci ) \
      || ( "$historical_profile" = true && "${PGDATABASE:-}" = epic6975_credential_historical_ci ) ) ]]; then
  :
else
  printf 'Credential writer proof requires its exact owned local database\n' >&2
  exit 1
fi
# The cutoff helper uses a URL, while psql uses PG*. Bind both authorities
# before any bootstrap can mutate roles or schemas.
vp exec node --input-type=module <<'NODE'
const address = new URL(process.env.CREDENTIAL_WRITER_PROOF_DATABASE_URL ?? '');
if (!['postgres:', 'postgresql:'].includes(address.protocol) || address.hostname !== process.env.PGHOST ||
    address.port !== process.env.PGPORT || decodeURIComponent(address.username) !== process.env.PGUSER ||
    decodeURIComponent(address.password) !== process.env.PGPASSWORD ||
    address.pathname !== `/${process.env.PGDATABASE}` || address.search || address.hash)
  throw new Error('Credential writer proof connection authorities differ');
NODE
historical_migration_directory=''
cleanup_historical_fixture() {
  [[ -z "$historical_migration_directory" ]] || rm -rf -- "$historical_migration_directory"
}
trap cleanup_historical_fixture EXIT
migration_directory="$PWD/packages/db/drizzle"
if [[ "$historical_profile" = true ]]; then
  historical_migration_directory="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-credential-historical-XXXXXX")"
  vp exec tsx packages/backend/src/auth/authority/__tests__/fixtures/prepare-credential-writer-historical-fixture.ts --out "$historical_migration_directory"
  migration_directory="$historical_migration_directory"
fi
# CI's service creates the canonical database. The second fixed database is
# created only after routing, exact target and historical provenance checks.
if [[ "$historical_profile" = true && "${PGPORT:-}" = 5432 ]]; then
  createdb --maintenance-db=postgres -- "$PGDATABASE"
fi
[[ "$(psql -X -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = 0 ]] || {
  printf 'Credential writer proof bootstrap requires a fresh database\n' >&2
  exit 1
}
psql -X -v ON_ERROR_STOP=1 -c 'CREATE SCHEMA neon_control_plane' -c 'CREATE TABLE neon_control_plane.endpoints (endpoint_id VARCHAR(255) NOT NULL PRIMARY KEY, allowed_ips VARCHAR(255))'
psql -X -v ON_ERROR_STOP=1 -f packages/db/docker/legacy-aurora-schema-stub.sql
psql -X -v ON_ERROR_STOP=1 -v boardsesh_dev_role_bootstrap=true -f packages/db/docker/bootstrap-pg18-development-roles.sql
SYNC_CUTOFF_ADMIN_DATABASE_URL="${CREDENTIAL_WRITER_PROOF_DATABASE_URL:?}" SYNC_CUTOFF_DEVELOPMENT_BOOTSTRAP=true \
  vp exec tsx packages/db/scripts/bootstrap-sync-deletions-cutoff-development.ts --apply
DRIZZLE_MIGRATIONS_DIR="$migration_directory" bash packages/db/docker/apply-drizzle-migrations.sh
