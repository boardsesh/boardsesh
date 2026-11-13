#!/usr/bin/env bash
set -Eeuo pipefail

# Fresh disposable proof databases only. Never accepts the seeded dev/main DB.
[[ "${PGHOST:-}" = 127.0.0.1 || "${PGHOST:-}" = localhost ]] || exit 1
if [[ "${PGPORT:-}" = 55479 && "${PGDATABASE:-}" =~ ^epic6975_location_[0-9]{8}$ ]]; then
  :
elif [[ "${CI:-}" = true && "${GITHUB_ACTIONS:-}" = true && "${PGPORT:-}" = 5432 && "${PGDATABASE:-}" = epic6975_location_ci ]]; then
  :
else
  printf 'Location proof requires its exact owned local database\n' >&2
  exit 1
fi
# The cutoff helper uses a URL, while psql uses PG*. Bind both authorities
# before any bootstrap can mutate roles or schemas.
vp exec node --input-type=module <<'NODE'
const address = new URL(process.env.LOCATION_SYNC_PROOF_DATABASE_URL ?? '');
if (!['postgres:', 'postgresql:'].includes(address.protocol) || address.hostname !== process.env.PGHOST ||
    address.port !== process.env.PGPORT || decodeURIComponent(address.username) !== process.env.PGUSER ||
    decodeURIComponent(address.password) !== process.env.PGPASSWORD ||
    address.pathname !== `/${process.env.PGDATABASE}` || address.search || address.hash)
  throw new Error('Location proof connection authorities differ');
NODE
[[ "$(psql -X -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = 0 ]] || {
  printf 'Location proof bootstrap requires a fresh database\n' >&2
  exit 1
}
psql -X -v ON_ERROR_STOP=1 -c 'CREATE SCHEMA neon_control_plane' -c 'CREATE TABLE neon_control_plane.endpoints (endpoint_id VARCHAR(255) NOT NULL PRIMARY KEY, allowed_ips VARCHAR(255))'
psql -X -v ON_ERROR_STOP=1 -f packages/db/docker/legacy-aurora-schema-stub.sql
psql -X -v ON_ERROR_STOP=1 -v boardsesh_dev_role_bootstrap=true -f packages/db/docker/bootstrap-pg18-development-roles.sql
SYNC_CUTOFF_ADMIN_DATABASE_URL="${LOCATION_SYNC_PROOF_DATABASE_URL:?}" SYNC_CUTOFF_DEVELOPMENT_BOOTSTRAP=true \
  vp exec tsx packages/db/scripts/bootstrap-sync-deletions-cutoff-development.ts --apply
DRIZZLE_MIGRATIONS_DIR="$PWD/packages/db/drizzle" bash packages/db/docker/apply-drizzle-migrations.sh
