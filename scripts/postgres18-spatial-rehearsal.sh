#!/usr/bin/env bash
#
# postgres18-spatial-rehearsal.sh — prove the PostGIS half of the PG16 -> PG18
# cutover, without touching production.
#
# `docs/postgres-18-migration.md` blocks the catalog audit unless the source and
# target PostGIS versions are equal. Railway production reports `3.7.0dev`,
# because the service tracks the mutable `postgis/postgis:16-master` tag; the
# attested PG18 image ships stable 3.6.4, and PGDG publishes no stable 3.7 for
# PostgreSQL 18. There is nothing to upgrade the target to, and
# `pg_extension.extversion` cannot be downgraded in place.
#
# So the question that actually decides the blocker is narrower than the gate:
# does everything this application does with PostGIS survive a dump taken from
# a 3.7.0dev source and restored into 3.6.4? That is answerable locally, in a
# few minutes, against the same image production runs — with no credential, no
# production read, and no 11 GB dump.
#
# This runs the same dump/restore mechanics as the real cutover:
# `scripts/postgres-logical-replication.sh` builds its schema dump with the same
# flags and filters `pg_restore --list` through the same awk expression, and
# treats any restore diagnostic as a failed gate. What differs is only the data
# volume and the fact that both endpoints are throwaway containers.
#
# Both containers run `POSTGRES_HOST_AUTH_METHOD=trust` on a private docker
# network with no published ports. That is deliberate: with no password anywhere
# there is no credential for this script to mishandle, and nothing here is ever
# pointed at a real database. Do not add a production URL to this file.
#
# Usage:
#   scripts/postgres18-spatial-rehearsal.sh [SOURCE_IMAGE] [TARGET_IMAGE]
#
# Environment:
#   SOURCE_IMAGE      default postgis/postgis:16-master (what production runs)
#   TARGET_IMAGE      default boardsesh-postgres-postgis:spatial-rehearsal,
#                     built from packages/db/docker/Dockerfile.postgres if absent.
#                     Set it to an attested digest to rehearse against the exact
#                     published artifact instead.
#   SOURCE_PLATFORM   default linux/amd64 (postgis/postgis publishes no arm64)
#   KEEP_CONTAINERS   set to `true` to leave both containers up for inspection
#   REHEARSAL_ROWS    default 500 fixture rows per spatial table

set -Eeuo pipefail
if [[ $- == *x* ]]; then set +x; fi
umask 077

SOURCE_IMAGE="${1:-${SOURCE_IMAGE:-postgis/postgis:16-master}}"
TARGET_IMAGE="${2:-${TARGET_IMAGE:-boardsesh-postgres-postgis:spatial-rehearsal}}"
SOURCE_PLATFORM="${SOURCE_PLATFORM:-linux/amd64}"
KEEP_CONTAINERS="${KEEP_CONTAINERS:-false}"
REHEARSAL_ROWS="${REHEARSAL_ROWS:-500}"
# Interpolated into an unquoted heredoc below, where a $( ) or a backtick would
# execute on this host. An unquoted heredoc has already produced one command
# substitution bug in this file; do not widen this.
[[ "$REHEARSAL_ROWS" =~ ^[1-9][0-9]*$ ]] || {
  printf 'REHEARSAL_ROWS must be a positive integer; got %s\n' "$REHEARSAL_ROWS" >&2
  exit 1
}

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPOSITORY_ROOT

# Deterministic names so a killed run cleans up on the next start rather than
# leaving an orphan holding port/volume state.
readonly NETWORK_NAME='boardsesh-spatial-rehearsal'
readonly SOURCE_CONTAINER='boardsesh-spatial-rehearsal-source'
readonly TARGET_CONTAINER='boardsesh-spatial-rehearsal-target'
readonly DATABASE_NAME='railway'
readonly OWNER_ROLE='boardsesh_owner'

fail() {
  printf 'PostGIS rehearsal failed: %s\n' "$*" >&2
  exit 1
}

step() {
  printf '\n=== %s\n' "$*"
}

# Docker Desktop on macOS does not put its CLI on PATH.
if ! command -v docker >/dev/null 2>&1; then
  if [[ -x /Applications/Docker.app/Contents/Resources/bin/docker ]]; then
    PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
    export PATH
  else
    fail 'docker is required'
  fi
fi
docker info >/dev/null 2>&1 || fail 'the docker daemon is not reachable'

cleanup() {
  [[ "$KEEP_CONTAINERS" == 'true' ]] && return 0
  docker rm -f "$SOURCE_CONTAINER" "$TARGET_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Client binaries live only inside the images; this host has no libpq at all.
# Every statement below runs through one of these two helpers.
source_psql() {
  docker exec -i -e PGDATABASE="$DATABASE_NAME" -u postgres "$SOURCE_CONTAINER" psql -v ON_ERROR_STOP=1 "$@"
}

# pg_dump/pg_restore always run from the TARGET container: PostgreSQL supports a
# newer client against an older server, never the reverse, and the target ships
# the 18.4 client. `target_client` reaches the source over the private network.
target_psql() {
  docker exec -i -e PGDATABASE="$DATABASE_NAME" -u postgres "$TARGET_CONTAINER" psql -v ON_ERROR_STOP=1 "$@"
}

target_client() {
  docker exec -i -u postgres "$TARGET_CONTAINER" "$@"
}

# A scalar query that errors must abort, not return the empty string. Command
# substitution in an argument list does not trip `set -e`, so without this a
# broken query on BOTH sides yields '' == '' and the comparison below reports a
# match. That is how the first version of this script "passed" its ST_AsEWKB
# checks against a function signature that does not exist.
scalar_source() {
  local value
  value="$(source_psql -X -Atq -c "$1")" || fail "source query failed: $1"
  printf '%s' "$value"
}
scalar_target() {
  local value
  value="$(target_psql -X -Atq -c "$1")" || fail "target query failed: $1"
  printf '%s' "$value"
}

wait_ready() {
  local container="$1" attempt=0
  # Probe TCP, not the unix socket. The official entrypoint runs its init
  # scripts (for postgis/postgis, that is what creates the postgis extension)
  # against a server that is not listening on TCP yet, so a socket-based
  # pg_isready reports ready in the middle of initialisation and the first
  # statement this script sends races the image's own CREATE EXTENSION.
  # TCP only opens once init has finished and the real server is up.
  #
  # 180s: the source image is amd64 and runs emulated on Apple Silicon, where
  # initdb plus the PostGIS install can take most of a minute.
  until docker exec "$container" pg_isready -h 127.0.0.1 -p 5432 -U postgres -q 2>/dev/null; do
    attempt=$((attempt + 1))
    [[ "$attempt" -lt 180 ]] || fail "$container did not become ready in 180s"
    docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -Fqx true ||
      fail "$container exited during startup: $(docker logs --tail 20 "$container" 2>&1)"
    sleep 1
  done
}

step "Rehearsal inputs"
printf 'source image: %s (%s)\n' "$SOURCE_IMAGE" "$SOURCE_PLATFORM"
printf 'target image: %s\n' "$TARGET_IMAGE"

if ! docker image inspect "$TARGET_IMAGE" >/dev/null 2>&1; then
  if [[ "$TARGET_IMAGE" == *@sha256:* ]]; then
    # A digest names a published artifact; building something else and calling
    # it that digest would make the whole rehearsal a lie.
    docker pull "$TARGET_IMAGE" ||
      fail "cannot pull $TARGET_IMAGE. GHCR requires a token with read:packages; run docker login ghcr.io, or omit TARGET_IMAGE to build the same Dockerfile locally"
  else
    step "Building the target image from packages/db/docker/Dockerfile.postgres"
    docker build -t "$TARGET_IMAGE" \
      -f "$REPOSITORY_ROOT/packages/db/docker/Dockerfile.postgres" \
      "$REPOSITORY_ROOT/packages/db/docker" ||
      fail 'target image build failed'
  fi
fi
docker image inspect "$SOURCE_IMAGE" >/dev/null 2>&1 ||
  docker pull --platform "$SOURCE_PLATFORM" "$SOURCE_IMAGE" || fail "cannot pull $SOURCE_IMAGE"

cleanup
docker network create "$NETWORK_NAME" >/dev/null

step "Starting both endpoints"
docker run -d --name "$SOURCE_CONTAINER" --network "$NETWORK_NAME" \
  --platform "$SOURCE_PLATFORM" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB="$DATABASE_NAME" \
  "$SOURCE_IMAGE" >/dev/null
docker run -d --name "$TARGET_CONTAINER" --network "$NETWORK_NAME" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB="$DATABASE_NAME" \
  "$TARGET_IMAGE" >/dev/null
wait_ready "$SOURCE_CONTAINER"
wait_ready "$TARGET_CONTAINER"

source_server_version="$(scalar_source 'SHOW server_version;')"
target_server_version="$(scalar_target 'SHOW server_version;')"
[[ "$source_server_version" == 16.* ]] ||
  fail "source must be PostgreSQL 16 to rehearse the real cross-major step; got $source_server_version"
[[ "$target_server_version" == 18.* ]] ||
  fail "target must be PostgreSQL 18; got $target_server_version"

step "Creating the source spatial surface (PostGIS ${source_server_version%%.*} side)"
# This is the application's complete PostGIS surface, copied from the migrations
# that created it: the two geography columns (0052, 0054), their two partial
# GiST indexes, and the trigger that derives the geography from lat/lng (0127).
#
# The trigger matters more than it looks. Its ST_MakePoint call lives inside a
# plpgsql body, which Postgres stores as opaque text — it produces no pg_depend
# edge to the PostGIS function. Any "which PostGIS functions does this database
# use?" check built on catalog dependencies alone will miss it, which is exactly
# why it is in the fixture.
source_psql <<SQL
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE gyms (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  latitude      double precision,
  longitude     double precision,
  is_public     boolean NOT NULL DEFAULT true,
  deleted_at    timestamptz,
  location      geography(Point, 4326)
);

CREATE TABLE user_boards (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  latitude      double precision,
  longitude     double precision,
  is_public     boolean NOT NULL DEFAULT true,
  deleted_at    timestamptz,
  location      geography(Point, 4326)
);

-- The pin matches migration 0205, so this fixture stays a faithful copy of the
-- migrated definition (#4699).
CREATE OR REPLACE FUNCTION set_location_from_coordinates() RETURNS trigger
  SET search_path = public, pg_catalog AS \$\$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location := ST_MakePoint(NEW.longitude, NEW.latitude)::geography;
  ELSE
    NEW.location := NULL;
  END IF;
  RETURN NEW;
END;
\$\$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER gyms_set_location
  BEFORE INSERT OR UPDATE OF latitude, longitude ON gyms
  FOR EACH ROW EXECUTE FUNCTION set_location_from_coordinates();

CREATE OR REPLACE TRIGGER user_boards_set_location
  BEFORE INSERT OR UPDATE OF latitude, longitude ON user_boards
  FOR EACH ROW EXECUTE FUNCTION set_location_from_coordinates();

CREATE INDEX gyms_location_idx ON gyms USING GIST (location)
  WHERE deleted_at IS NULL AND is_public = true;
CREATE INDEX user_boards_location_gist_idx ON user_boards USING GIST (location)
  WHERE is_public = true AND deleted_at IS NULL;
SQL

# Production has roughly one populated location in every two rows on both
# tables, so leave a comparable share NULL: a dump that silently coerced NULL
# geography to a point would otherwise pass unnoticed.
source_psql <<SQL
INSERT INTO gyms (name, latitude, longitude, is_public, deleted_at)
SELECT
  'gym ' || n,
  CASE WHEN n % 2 = 0 THEN NULL ELSE -90 + (n * 179.0 / $REHEARSAL_ROWS) END,
  CASE WHEN n % 2 = 0 THEN NULL ELSE -180 + (n * 359.0 / $REHEARSAL_ROWS) END,
  n % 7 <> 0,
  CASE WHEN n % 11 = 0 THEN now() ELSE NULL END
FROM generate_series(1, $REHEARSAL_ROWS) AS n;

INSERT INTO user_boards (name, latitude, longitude, is_public, deleted_at)
SELECT
  'board ' || n,
  CASE WHEN n % 2 = 0 THEN NULL ELSE -89 + (n * 178.0 / $REHEARSAL_ROWS) END,
  CASE WHEN n % 2 = 0 THEN NULL ELSE -179 + (n * 357.0 / $REHEARSAL_ROWS) END,
  n % 5 <> 0,
  CASE WHEN n % 13 = 0 THEN now() ELSE NULL END
FROM generate_series(1, $REHEARSAL_ROWS) AS n;
SQL

source_postgis="$(scalar_source "SELECT extversion FROM pg_extension WHERE extname = 'postgis';")"
source_full="$(scalar_source 'SELECT postgis_full_version();')"

step "Preparing the target (extensions pre-created by the admin, as at cutover)"
target_psql <<SQL
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE ROLE $OWNER_ROLE NOLOGIN;
GRANT CREATE ON DATABASE $DATABASE_NAME TO $OWNER_ROLE;
GRANT USAGE, CREATE ON SCHEMA public TO $OWNER_ROLE;
-- postgres-logical-replication.sh pre-creates every included schema
-- AUTHORIZATION the owner role and then ALTERs its owner, because the restore
-- runs with --role set to the owner role, and the dump carries a
-- COMMENT ON SCHEMA public that only the schema owner may execute. Without
-- this the restore emits a diagnostic and the gate fails, which is exactly
-- what that ALTER exists to prevent.
ALTER SCHEMA public OWNER TO $OWNER_ROLE;
SQL
target_postgis="$(scalar_target "SELECT extversion FROM pg_extension WHERE extname = 'postgis';")"
target_full="$(scalar_target 'SELECT postgis_full_version();')"

printf 'source PostGIS: %s\n' "$source_postgis"
printf 'target PostGIS: %s\n' "$target_postgis"
[[ "$target_postgis" == '3.6.4' ]] ||
  fail "target PostGIS is $target_postgis; the attested artifact is pinned to 3.6.4 and this rehearsal is only evidence about that version"
if [[ "$source_postgis" == "$target_postgis" ]]; then
  fail "source and target PostGIS are both $source_postgis, so this run proves nothing about the version step the blocker is about. The mutable postgis/postgis:16-master tag has moved; pin SOURCE_IMAGE to a build that still reports a different version"
fi

# Same flags and same --use-list filter as postgres-logical-replication.sh setup,
# over public only: the real cutover also carries drizzle, which holds migration
# bookkeeping and no spatial object.
step "Dumping the source schema"
target_client bash -euo pipefail -c "
  export PGHOST=$SOURCE_CONTAINER PGUSER=postgres PGDATABASE=$DATABASE_NAME
  pg_dump --schema-only --no-owner --no-acl --no-publications --no-subscriptions \
    --schema=public --format=custom --file /tmp/schema.dump
"

# The target admin pre-created the extensions, so the source's own CREATE
# EXTENSION entries must not run; COMMENT entries cannot run as the app owner.
# Identical filter to the cutover helper.
target_client bash -euo pipefail -c "
  pg_restore --list /tmp/schema.dump >/tmp/restore.list
  awk '\$0 !~ / SCHEMA - / && \$0 !~ / EXTENSION - / && \$0 !~ / COMMENT - EXTENSION / && \$0 !~ / OPERATOR FAMILY / && \$0 !~ / OPERATOR CLASS / { print }' \
    /tmp/restore.list >/tmp/restore.filtered
"

step "Restoring the schema into PostGIS $target_postgis"
# Two separate gates, matching postgres-logical-replication.sh: a non-zero exit,
# and any diagnostic at all. Checking only the captured stderr would let a
# restore that died after the COPYs but before the trailing catalog entries read
# as clean, because docker exec's own failure never lands in the capture.
restore_status=0
restore_stderr="$(docker exec -i -u postgres "$TARGET_CONTAINER" bash -c "
  pg_restore --exit-on-error --schema-only --no-owner --no-acl \
    --role $OWNER_ROLE --use-list /tmp/restore.filtered \
    --dbname $DATABASE_NAME /tmp/schema.dump 2>&1 >/dev/null
")" || restore_status=$?
[[ "$restore_status" -eq 0 ]] || {
  printf '%s\n' "$restore_stderr" >&2
  fail "schema restore exited $restore_status"
}
if [[ -n "$restore_stderr" ]]; then
  printf '%s\n' "$restore_stderr" >&2
  fail 'schema restore reported diagnostics; the cutover helper treats every restore warning as a failed gate, so this rehearsal does too'
fi

step "Copying every geography value"
target_client bash -euo pipefail -c "
  export PGHOST=$SOURCE_CONTAINER PGUSER=postgres PGDATABASE=$DATABASE_NAME
  pg_dump --data-only --format=custom --table=public.gyms --table=public.user_boards \
    --file /tmp/spatial.dump
"
# --disable-triggers models what the real cutover does. The cutover copies data
# by logical replication, and a subscriber does not fire ordinary triggers on
# apply -- only ones marked ENABLE ALWAYS/REPLICA, of which this schema has
# none. Restoring with triggers live would be a *different* operation.
#
# It used to be load-bearing for a second reason, now fixed. pg_restore emits
#   SELECT pg_catalog.set_config('search_path', '', false);
# and migration 0127's set_location_from_coordinates() had proconfig NULL, so
# its unqualified `geography` cast could not resolve while the trigger fired
# during COPY -- and update_vote_counts() failed even earlier, at plpgsql
# compilation of its `DECLARE v_entity_type social_entity_type`. That broke
# `pg_restore --data-only` into an already-loaded schema, which is this restore.
# It never broke a full pg_dump/pg_restore (triggers are post-data, emitted
# after COPY), so the shadow-period "backup/restore of PG18 succeeds
# independently" gate and the failback drill were never at risk. Migration 0205
# pins search_path on all fourteen of our trigger functions (#4699).
#
# The pin removes the hard error; it does not remove the reason for the flag.
# Pinned triggers no longer fail, they RUN, so a data-only reload recomputes
# derived data from the rows it just loaded rather than restoring what the dump
# recorded -- location from lat/lng, vote_counts from votes. On a
# self-consistent dump that is the same answer (measured: identical row counts
# and an identical vote_counts checksum with and without the flag), but it
# diverges the moment a dumped derived value disagrees with its source rows.
# And COPY votes populates vote_counts through the trigger, so a later
# COPY vote_counts collides on vote_counts_entity_type_entity_id_pk -- today
# only because pg_dump emits TABLE DATA alphabetically and vote_counts sorts
# before votes. See docs/postgres-18-postgis-rehearsal.md.
data_status=0
data_stderr="$(docker exec -i -u postgres "$TARGET_CONTAINER" bash -c "
  pg_restore --exit-on-error --data-only --disable-triggers --dbname $DATABASE_NAME /tmp/spatial.dump 2>&1 >/dev/null
")" || data_status=$?
[[ "$data_status" -eq 0 ]] || {
  printf '%s\n' "$data_stderr" >&2
  fail "data restore exited $data_status"
}
if [[ -n "$data_stderr" ]]; then
  printf '%s\n' "$data_stderr" >&2
  fail 'data restore reported diagnostics'
fi

step "Verifying"
failures=0

# Runs the query itself on both sides rather than taking two pre-substituted
# values. `fail` inside a `$( )` argument only exits the subshell, so the older
# shape reported an abort and then carried on; here a broken query stops the run
# where it happens.
check_sql() {
  local description="$1" query="$2" source_value target_value
  source_value="$(source_psql -X -Atq -c "$query")" || fail "source query failed: $query"
  target_value="$(target_psql -X -Atq -c "$query")" || fail "target query failed: $query"
  # An empty result is never a meaningful spatial answer, and two empties
  # comparing equal is the exact failure this verification exists to avoid: the
  # first version of this script "passed" its EWKB checks against a function
  # signature that does not exist, because both sides errored to ''.
  if [[ -z "$source_value" || -z "$target_value" ]]; then
    printf '  FAIL  %s\n        empty result on at least one side; the check itself is broken\n' "$description"
    failures=$((failures + 1))
    return
  fi
  if [[ "$source_value" == "$target_value" ]]; then
    printf '  ok    %s\n' "$description"
  else
    printf '  FAIL  %s\n        source: %s\n        target: %s\n' "$description" "$source_value" "$target_value"
    failures=$((failures + 1))
  fi
}

report_fail() {
  printf '  FAIL  %s\n' "$*"
  failures=$((failures + 1))
}

for spatial_table in gyms user_boards; do
  check_sql "$spatial_table row count" \
    "SELECT count(*) FROM $spatial_table;"
  check_sql "$spatial_table populated geography count" \
    "SELECT count(location) FROM $spatial_table;"
  check_sql "$spatial_table column type" \
    "SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = '$spatial_table'::regclass AND a.attname = 'location';"

  # ST_AsEWKB over every populated row, in a stable order. This is the
  # comparison docs/postgres-18-migration.md asks for by name: it reads the
  # on-the-wire binary of each geography, not a rendering of it. ST_AsEWKB is
  # defined over geometry, hence the cast -- passing a geography raises
  # "function st_asewkb(geography) does not exist", which is what made the first
  # version of this check vacuous.
  check_sql "$spatial_table ST_AsEWKB digest over every populated row" \
    "SELECT md5(string_agg(encode(ST_AsEWKB(location::geometry), 'hex'), ',' ORDER BY id)) FROM $spatial_table WHERE location IS NOT NULL;"

  # A second, independent rendering. packages/db/src/__tests__/
  # location-trigger.integration.test.ts asserts against ST_AsText(location::
  # geometry), so a WKT that shifted across the version step would break that
  # suite even though the EWKB matched.
  check_sql "$spatial_table ST_AsText digest over every populated row" \
    "SELECT md5(string_agg(ST_AsText(location::geometry), ',' ORDER BY id)) FROM $spatial_table WHERE location IS NOT NULL;"

  # The repo's own order-independent row digest, from
  # scripts/postgres-table-digests.sql, which is what the cutover compares.
  check_sql "$spatial_table whole-row digest" \
    "SELECT coalesce(sum(hashtextextended(row_to_json(t)::text, 0)), 0) FROM $spatial_table AS t;"

  # The --disable-triggers copy models logical-replication apply, which runs
  # with session_replication_role = replica and so fires only ENABLE ALWAYS /
  # REPLICA triggers. That equivalence holds only while there are none.
  always_triggers="$(scalar_source "SELECT count(*) FROM pg_trigger WHERE tgrelid = '$spatial_table'::regclass AND NOT tgisinternal AND tgenabled IN ('A', 'R');")"
  if [[ "$always_triggers" == '0' ]]; then
    printf '  ok    %s has no ENABLE ALWAYS/REPLICA trigger, so the copy model holds\n' "$spatial_table"
  else
    report_fail "$spatial_table has $always_triggers ENABLE ALWAYS/REPLICA trigger(s); --disable-triggers no longer models logical-replication apply"
  fi
done

check_sql 'gyms_location_idx definition' \
  "SELECT indexdef FROM pg_indexes WHERE indexname = 'gyms_location_idx';"
check_sql 'user_boards_location_gist_idx definition' \
  "SELECT indexdef FROM pg_indexes WHERE indexname = 'user_boards_location_gist_idx';"

# The probe point has to sit among the fixture's points. An earlier version used
# (4.9, 52.4), whose nearest fixture point is 4,345 km away against a 2,000 km
# radius: the count was 0 on both sides, no bbox candidate ever reached the
# exact geodesic ST_DWithin, and the check passed while proving nothing. The
# bounds assertion below is what stops that regressing -- the answer must be a
# strict subset of the eligible rows, so neither 0 nor "everything" can pass.
readonly PROBE_LONGITUDE='4.9'
readonly PROBE_LATITUDE='2.2'
readonly PROBE_RADIUS_METRES='2000000'
eligible_query="SELECT count(*) FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL;"
proximity_query="SELECT count(*) FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint($PROBE_LONGITUDE, $PROBE_LATITUDE)::geography, $PROBE_RADIUS_METRES);"

eligible_count="$(scalar_source "$eligible_query")"
proximity_count="$(scalar_source "$proximity_query")"
if [[ "$proximity_count" -gt 0 && "$proximity_count" -lt "$eligible_count" ]]; then
  printf '  ok    proximity probe discriminates: %s of %s eligible rows are within %skm\n' \
    "$proximity_count" "$eligible_count" "$((PROBE_RADIUS_METRES / 1000))"
else
  report_fail "proximity probe matched $proximity_count of $eligible_count eligible rows; it must exercise both the accept and the reject path or the comparison below proves nothing"
fi
check_sql 'ST_DWithin proximity result' "$proximity_query"

check_sql 'ST_Distance aggregate' \
  "SELECT round(sum(ST_Distance(location, ST_MakePoint($PROBE_LONGITUDE, $PROBE_LATITUDE)::geography))::numeric, 3) FROM gyms WHERE location IS NOT NULL;"

# An index whose definition survived but which the planner will not use, or
# which returns wrongly-empty results, is the failure a definition comparison
# alone would miss. Match the plan's own "Index Scan using <name>" wording
# rather than the bare name, which appears in the index predicate text too.
target_plan="$(target_psql -X -Atq -c "EXPLAIN (COSTS OFF) $proximity_query" | tr '\n' ' ')"
if [[ "$target_plan" == *'using gyms_location_idx'* ]]; then
  printf '  ok    partial GiST index is chosen on the target\n'
else
  report_fail "target plan does not scan gyms_location_idx: $target_plan"
fi

# The trigger travelled as plpgsql source text. Prove it still computes an
# identical geography under 3.6.4 rather than merely existing. A trigger that
# did not fire would leave location NULL, encode(NULL) empty, and check_sql
# rejects an empty side.
check_sql 'trigger-derived geography for an identical lat/lng' \
  "INSERT INTO gyms (name, latitude, longitude) VALUES ('trigger probe', 52.3676, 4.9041) RETURNING encode(ST_AsEWKB(location::geometry), 'hex');"

step "Result"
printf 'source: PostgreSQL %s, PostGIS %s\n' "$source_server_version" "$source_postgis"
printf 'target: PostgreSQL %s, PostGIS %s\n' "$target_server_version" "$target_postgis"
printf 'source postgis_full_version(): %s\n' "$source_full"
printf 'target postgis_full_version(): %s\n' "$target_full"

if [[ "$failures" -ne 0 ]]; then
  fail "$failures spatial check(s) did not match across the PostGIS $source_postgis -> $target_postgis step"
fi

printf '\nEvery spatial check matched across PostGIS %s -> %s.\n' "$source_postgis" "$target_postgis"
printf 'This is evidence about the application spatial surface only: two geography(Point,4326)\n'
printf 'columns, two partial GiST indexes, the lat/lng trigger, and ST_MakePoint/ST_Distance/\n'
printf 'ST_DWithin. scripts/postgres18-spatial-surface.test.sh is what keeps that list honest.\n'
printf 'It is NOT the docs/postgres-18-migration.md section 4 rehearsal: no whole-catalog\n'
printf 'fingerprint diff, no sequence fence, no failback drill, and no real production data.\n'
