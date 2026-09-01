#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPOSITORY_ROOT
readonly POSTGRES16_IMAGE='postgis/postgis@sha256:afaf08e1937d753762cfdb943c69ed46296bf50faa80c5f89494e2d0d12980de'
readonly POSTGRES16_PLATFORM='linux/amd64'
readonly CONTAINER_NAME="boardsesh-pg16-collation-${GITHUB_RUN_ID:-local}-${$}"
readonly VOLUME_NAME="boardsesh-pg16-collation-${GITHUB_RUN_ID:-local}-${$}"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-pg16-collation.XXXXXX")"
readonly TEST_ROOT
readonly STATE_DIRECTORY="$TEST_ROOT/state"
readonly UNPINNED_STATE_DIRECTORY="$TEST_ROOT/unpinned-state"
readonly TAMPERED_STATE_DIRECTORY="$TEST_ROOT/tampered-state"
readonly REPORT_FILE="$TEST_ROOT/report"
readonly CONTAINMENT_EVIDENCE_SHA256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

cleanup() {
  docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

assert_report_contains() {
  local expected_message="$1"
  if ! grep -Fq "$expected_message" "$REPORT_FILE"; then
    cat "$REPORT_FILE" >&2
    printf 'Expected report to contain: %s\n' "$expected_message" >&2
    exit 1
  fi
}

docker volume create "$VOLUME_NAME" >/dev/null
docker run --detach \
  --platform "$POSTGRES16_PLATFORM" \
  --name "$CONTAINER_NAME" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=postgres \
  --env POSTGRES_INITDB_ARGS='--locale=en_US.utf8' \
  --publish 127.0.0.1::5432 \
  --volume "$VOLUME_NAME:/var/lib/postgresql/data" \
  "$POSTGRES16_IMAGE" >/dev/null

host_port="$(docker port "$CONTAINER_NAME" 5432/tcp | sed -n 's/^127\.0\.0\.1://p' | head -n 1)"
[[ "$host_port" =~ ^[0-9]+$ ]]
readonly host_port

attempt=0
while [[ "$attempt" -lt 120 ]]; do
  if PGPASSWORD=postgres psql -X -Atq \
    -h 127.0.0.1 -p "$host_port" -U postgres -d postgres \
    -c 'SELECT 1;' >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [[ "$attempt" -eq 120 ]]; then
  docker logs "$CONTAINER_NAME" >&2 || true
  printf 'PostgreSQL 16 collation fixture did not become ready\n' >&2
  exit 1
fi

PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p "$host_port" -U postgres -d postgres <<'SQL'
CREATE DATABASE railway
  WITH TEMPLATE template0
       ENCODING 'UTF8'
       LOCALE_PROVIDER libc
       LC_COLLATE 'en_US.utf8'
       LC_CTYPE 'en_US.utf8'
       COLLATION_VERSION '0';
SQL

PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway <<'SQL'
CREATE EXTENSION amcheck;
CREATE EXTENSION postgis;
CREATE TABLE public.collation_probe (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  marker text NOT NULL UNIQUE,
  detail text NOT NULL
);
CREATE INDEX collation_probe_detail_idx ON public.collation_probe (detail);
INSERT INTO public.collation_probe (marker, detail)
VALUES ('alpha', 'Ångström'), ('beta', 'Zulu'), ('gamma', 'ábaco');
CREATE COLLATION public.unused_old_libc
  (provider = libc, locale = 'en_US.utf8', version = '0');
CREATE TABLE public.gyms (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  location public.geography(Point, 4326),
  deleted_at timestamptz,
  is_public boolean NOT NULL DEFAULT true
);
CREATE INDEX gyms_location_idx ON public.gyms USING gist (location)
WHERE deleted_at IS NULL AND is_public = true;
CREATE TABLE public.user_boards (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  location public.geography(Point, 4326),
  deleted_at timestamptz,
  is_public boolean NOT NULL DEFAULT true
);
CREATE INDEX user_boards_location_gist_idx ON public.user_boards USING gist (location)
WHERE is_public = true AND deleted_at IS NULL;
INSERT INTO public.gyms (location)
VALUES (public.ST_SetSRID(public.ST_MakePoint(153.03, -27.47), 4326)::public.geography);
INSERT INTO public.user_boards (location)
VALUES (public.ST_SetSRID(public.ST_MakePoint(153.02, -27.46), 4326)::public.geography);
SQL

readonly admin_url="postgresql://postgres:postgres@127.0.0.1:${host_port}/railway"
readonly image_reference="$POSTGRES16_IMAGE"
system_identifier="$(PGPASSWORD=postgres psql -X -Atq \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway \
  -c 'SELECT system_identifier FROM pg_catalog.pg_control_system();')"
readonly system_identifier

pg_amcheck() {
  if [[ "$#" -eq 1 && "$1" == '--version' ]]; then
    docker exec "$CONTAINER_NAME" pg_amcheck --version
  elif [[ "${PG_AMCHECK_SMOKE_FAIL:-false}" == 'true' ]]; then
    printf 'simulated pg_amcheck corruption report\n' >&2
    return 42
  else
    docker exec "$CONTAINER_NAME" pg_amcheck -U postgres -d railway "$@"
  fi
}
export -f pg_amcheck
export CONTAINER_NAME

if EXPECTED_SYSTEM_IDENTIFIER=12345 \
  ADMIN_DATABASE_URL="$admin_url" \
  SOURCE_IMAGE_REFERENCE="$image_reference" \
  SOURCE_IMAGE_PIN_CONFIRMED=true \
  CONNECTION_CONTAINMENT_VERIFIED=true \
  CONNECTION_CONTAINMENT_EVIDENCE_SHA256="$CONTAINMENT_EVIDENCE_SHA256" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" audit "$STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected the pre-known system identifier to reject the audit target\n' >&2
  exit 1
fi
assert_report_contains 'cluster system identifier is'

EXPECTED_SYSTEM_IDENTIFIER="$system_identifier" \
ADMIN_DATABASE_URL="$admin_url" \
SOURCE_IMAGE_REFERENCE="$image_reference" \
SOURCE_IMAGE_PIN_CONFIRMED=true \
CONNECTION_CONTAINMENT_VERIFIED=true \
CONNECTION_CONTAINMENT_EVIDENCE_SHA256="$CONTAINMENT_EVIDENCE_SHA256" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" audit "$STATE_DIRECTORY" \
  >"$REPORT_FILE" 2>&1
assert_report_contains 'Database collation mismatch: 0 ->'
assert_report_contains 'Full user-index manifest: 8 indexes'
assert_report_contains 'Dependency-free named collations queued for final refresh: 1'

cp -R "$STATE_DIRECTORY" "$TAMPERED_STATE_DIRECTORY"
printf '\n' >>"$TAMPERED_STATE_DIRECTORY/indexes.tsv"
if EXPECTED_SYSTEM_IDENTIFIER="$system_identifier" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" status "$TAMPERED_STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected a tampered index inventory to fail closed\n' >&2
  exit 1
fi
assert_report_contains 'index inventory file does not match its audited SHA-256'

mkdir -m 0700 "$STATE_DIRECTORY/.operation.lock"
printf 'pid\t999999\noperation\ttest\n' >"$STATE_DIRECTORY/.operation.lock/owner.tsv"
chmod 0600 "$STATE_DIRECTORY/.operation.lock/owner.tsv"
if EXPECTED_SYSTEM_IDENTIFIER="$system_identifier" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" status "$STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected an existing operation lock to block concurrent state access\n' >&2
  exit 1
fi
assert_report_contains 'repair state is locked'
mv "$STATE_DIRECTORY/.operation.lock" "$TEST_ROOT/recovered-stale-lock"

repair_ack="$(awk -F '\t' '$1 == "repair_ack" { print $2 }' "$STATE_DIRECTORY/metadata.tsv")"
maintenance_ack="$(awk -F '\t' '$1 == "maintenance_ack" { print $2 }' "$STATE_DIRECTORY/metadata.tsv")"
[[ -n "$repair_ack" && -n "$system_identifier" && -n "$maintenance_ack" ]]

EXPECTED_SYSTEM_IDENTIFIER="$system_identifier" \
ADMIN_DATABASE_URL="$admin_url" \
SOURCE_IMAGE_REFERENCE="$image_reference" \
SOURCE_IMAGE_PIN_CONFIRMED=false \
CONNECTION_CONTAINMENT_VERIFIED=true \
CONNECTION_CONTAINMENT_EVIDENCE_SHA256="$CONTAINMENT_EVIDENCE_SHA256" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" audit "$UNPINNED_STATE_DIRECTORY" \
  >"$REPORT_FILE" 2>&1
unpinned_repair_ack="$(awk -F '\t' '$1 == "repair_ack" { print $2 }' "$UNPINNED_STATE_DIRECTORY/metadata.tsv")"
if COLLATION_REPAIR_ACK="$unpinned_repair_ack" \
  EXPECTED_SYSTEM_IDENTIFIER="$system_identifier" \
  CONNECTION_CONTAINMENT_EVIDENCE_SHA256="$CONTAINMENT_EVIDENCE_SHA256" \
  BACKUP_RESTORE_VERIFIED=true \
  RESTORED_CLONE_AMCHECK_VERIFIED=true \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" reindex-next "$UNPINNED_STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected an unconfirmed Railway image pin to block reindex-next\n' >&2
  exit 1
fi
assert_report_contains 'did not confirm Railway was deployed from the immutable source image pin'

if EXPECTED_SYSTEM_IDENTIFIER="$system_identifier" \
  CONNECTION_CONTAINMENT_EVIDENCE_SHA256="$CONTAINMENT_EVIDENCE_SHA256" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" reindex-next "$STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected reindex-next without acknowledgements to fail\n' >&2
  exit 1
fi
assert_report_contains 'COLLATION_REPAIR_ACK must exactly equal'

common_repair_environment=(
  COLLATION_REPAIR_ACK="$repair_ack"
  EXPECTED_SYSTEM_IDENTIFIER="$system_identifier"
  CONNECTION_CONTAINMENT_EVIDENCE_SHA256="$CONTAINMENT_EVIDENCE_SHA256"
  BACKUP_RESTORE_VERIFIED=true
  RESTORED_CLONE_AMCHECK_VERIFIED=true
  RESOURCE_CPU_PERCENT_15M=1
  RESOURCE_MEMORY_BYTES=1000000000
  RESOURCE_MEMORY_LIMIT_BYTES=24000000000
  RESOURCE_DISK_FREE_BYTES=130000000000
  RESOURCE_DISK_CAPACITY_BYTES=150000000000
)

PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway \
  -c 'CREATE PUBLICATION boardsesh_repair_smoke FOR TABLE public.collation_probe;' \
  >/dev/null
if env "${common_repair_environment[@]}" \
  RESOURCE_SAMPLE_EPOCH="$(date +%s)" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" reindex-next "$STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected a post-audit replication object to block repair\n' >&2
  exit 1
fi
assert_report_contains 'publication, subscription, or replication-slot objects exist'
PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway \
  -c 'DROP PUBLICATION boardsesh_repair_smoke;' >/dev/null

audit_index_bytes="$(awk -F '\t' 'NR == 1 { print $5 }' "$STATE_DIRECTORY/indexes.tsv")"
PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway <<'SQL'
INSERT INTO public.collation_probe (marker, detail)
SELECT 'bulk-' || generated_row, repeat('z', 500) || generated_row
FROM generate_series(1, 20000) AS generated_row;
DELETE FROM public.collation_probe WHERE id > 3;
INSERT INTO public.gyms (location)
SELECT public.ST_SetSRID(
         public.ST_MakePoint((generated_row % 360) - 180, (generated_row % 180) - 90),
         4326)::public.geography
FROM generate_series(1, 20000) AS generated_row;
DELETE FROM public.gyms WHERE id > 1;
INSERT INTO public.user_boards (location)
SELECT public.ST_SetSRID(
         public.ST_MakePoint((generated_row % 360) - 180, (generated_row % 180) - 90),
         4326)::public.geography
FROM generate_series(1, 20000) AS generated_row;
DELETE FROM public.user_boards WHERE id > 1;
INSERT INTO public.spatial_ref_sys (srid, auth_name, auth_srid, srtext, proj4text)
SELECT 900000 + generated_row,
       'boardsesh-smoke',
       900000 + generated_row,
       'LOCAL_CS["boardsesh"]',
       ''
FROM generate_series(1, 50000) AS generated_row
ON CONFLICT (srid) DO NOTHING;
DELETE FROM public.spatial_ref_sys WHERE auth_name = 'boardsesh-smoke';
SQL
IFS=$'\t' read -r first_index_schema first_index_name _ \
  <"$STATE_DIRECTORY/indexes.tsv"
live_index_bytes="$(PGPASSWORD=postgres psql -X -Atq \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "
SELECT pg_catalog.pg_relation_size(index_relation.oid)
FROM pg_catalog.pg_index AS index_row
JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
WHERE index_namespace.nspname = '$first_index_schema'
  AND index_relation.relname = '$first_index_name';")"
[[ "$live_index_bytes" -gt "$audit_index_bytes" ]]

if env "${common_repair_environment[@]}" \
  MIN_DISK_FREE_BASE_BYTES=1 \
  MAX_PROJECTED_DISK_PERCENT=100 \
  RESOURCE_DISK_FREE_BYTES="$((audit_index_bytes * 3 + 1))" \
  RESOURCE_SAMPLE_EPOCH="$(date +%s)" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" reindex-next "$STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected the current grown index size to fail the disk gate\n' >&2
  exit 1
fi
assert_report_contains 'disk headroom is'

if env "${common_repair_environment[@]}" \
  RESOURCE_SAMPLE_EPOCH=1 \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" reindex-next "$STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected a stale Railway resource sample to fail\n' >&2
  exit 1
fi
assert_report_contains 'require a fresh sample'

reindex_attempt=0
while [[ ! -f "$STATE_DIRECTORY/user-reindex.complete" && "$reindex_attempt" -lt 10 ]]; do
  env "${common_repair_environment[@]}" \
    RESOURCE_SAMPLE_EPOCH="$(date +%s)" \
    ADMIN_DATABASE_URL="$admin_url" \
    "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" reindex-next "$STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1
  reindex_attempt=$((reindex_attempt + 1))
done
[[ -f "$STATE_DIRECTORY/user-reindex.complete" ]]
[[ "$(wc -l <"$STATE_DIRECTORY/completed-indexes.txt" | tr -d ' ')" == '8' ]]

if env "${common_repair_environment[@]}" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" reindex-system "$STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected reindex-system without a maintenance fence to fail\n' >&2
  exit 1
fi
assert_report_contains 'WRITES_FENCED=true is required'

env "${common_repair_environment[@]}" \
  WRITES_FENCED=true \
  CLIENTS_FENCED=true \
  MAINTENANCE_WINDOW_ACK="$maintenance_ack" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" reindex-system "$STATE_DIRECTORY" \
  >"$REPORT_FILE" 2>&1
assert_report_contains 'System catalog reindex complete'

if env "${common_repair_environment[@]}" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" validate "$STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected validation without production pg_amcheck evidence to fail\n' >&2
  exit 1
fi
assert_report_contains 'production pg_amcheck evidence marker is missing'

if env "${common_repair_environment[@]}" \
  PG_AMCHECK_SMOKE_FAIL=true \
  WRITES_FENCED=true \
  CLIENTS_FENCED=true \
  MAINTENANCE_WINDOW_ACK="$maintenance_ack" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" amcheck "$STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected a failed pg_amcheck to stop the repair\n' >&2
  exit 1
fi
assert_report_contains 'retained its transcript'
failed_amcheck_logs=("$STATE_DIRECTORY"/production-amcheck.failed.*.log)
[[ "${#failed_amcheck_logs[@]}" -eq 1 && -f "${failed_amcheck_logs[0]}" ]]
grep -Fq 'simulated pg_amcheck corruption report' "${failed_amcheck_logs[0]}"

env "${common_repair_environment[@]}" \
  WRITES_FENCED=true \
  CLIENTS_FENCED=true \
  MAINTENANCE_WINDOW_ACK="$maintenance_ack" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" amcheck "$STATE_DIRECTORY" \
  >"$REPORT_FILE" 2>&1
assert_report_contains 'Production pg_amcheck completed'

env "${common_repair_environment[@]}" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" validate "$STATE_DIRECTORY" \
  >"$REPORT_FILE" 2>&1
assert_report_contains 'Collation repair validation passed'
refresh_ack="$(sed -n 's/^COLLATION_REFRESH_ACK=//p' "$REPORT_FILE")"
[[ -n "$refresh_ack" ]]

if env "${common_repair_environment[@]}" \
  WRITES_FENCED=true \
  CLIENTS_FENCED=true \
  MAINTENANCE_WINDOW_ACK="$maintenance_ack" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" refresh "$STATE_DIRECTORY" \
    >"$REPORT_FILE" 2>&1; then
  printf 'Expected refresh without its final acknowledgement to fail\n' >&2
  exit 1
fi
assert_report_contains 'COLLATION_REFRESH_ACK must exactly equal'

env "${common_repair_environment[@]}" \
  WRITES_FENCED=true \
  CLIENTS_FENCED=true \
  MAINTENANCE_WINDOW_ACK="$maintenance_ack" \
  COLLATION_REFRESH_ACK="$refresh_ack" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" refresh "$STATE_DIRECTORY" \
  >"$REPORT_FILE" 2>&1
assert_report_contains 'Database collation version now records'

# Model a client disconnect after both catalog commits but before the local
# completion markers were durable. The started markers must make a retry
# reconcile live state without issuing an unsafe second transition.
rm "$STATE_DIRECTORY/named-collations-refresh.complete" \
  "$STATE_DIRECTORY/collation-refresh.complete"
env "${common_repair_environment[@]}" \
  WRITES_FENCED=true \
  CLIENTS_FENCED=true \
  MAINTENANCE_WINDOW_ACK="$maintenance_ack" \
  COLLATION_REFRESH_ACK="$refresh_ack" \
  ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" refresh "$STATE_DIRECTORY" \
  >"$REPORT_FILE" 2>&1
assert_report_contains 'Reconciling a database collation refresh'
[[ -f "$STATE_DIRECTORY/named-collations-refresh.complete" ]]
[[ -f "$STATE_DIRECTORY/collation-refresh.complete" ]]

collation_contract="$(PGPASSWORD=postgres psql -X -Atq -F '|' \
  -h 127.0.0.1 -p "$host_port" -U postgres -d railway -c "
SELECT database.datcollversion = pg_catalog.pg_database_collation_actual_version(database.oid),
       (SELECT count(*) = 0
        FROM pg_catalog.pg_collation AS collation_row
        WHERE collation_row.collversion IS NOT NULL
          AND pg_catalog.pg_collation_actual_version(collation_row.oid) IS NOT NULL
          AND collation_row.collversion <> pg_catalog.pg_collation_actual_version(collation_row.oid)),
       (SELECT count(*) = 3 FROM public.collation_probe),
       (SELECT count(*) = 1 FROM public.gyms),
       (SELECT count(*) = 1 FROM public.user_boards)
FROM pg_catalog.pg_database AS database
WHERE database.datname = current_database();")"
[[ "$collation_contract" == 't|t|t|t|t' ]]

EXPECTED_SYSTEM_IDENTIFIER="$system_identifier" \
ADMIN_DATABASE_URL="$admin_url" \
  "$REPOSITORY_ROOT/scripts/postgres16-collation-repair.sh" status "$STATE_DIRECTORY" \
  >"$REPORT_FILE" 2>&1
assert_report_contains 'User indexes: 8/8 complete; 0 remaining.'
assert_report_contains 'Production pg_amcheck: complete.'
assert_report_contains 'Collation version refresh: complete.'

printf 'PostgreSQL 16 collation repair is gated, resumable, and refreshes versions last.\n'
