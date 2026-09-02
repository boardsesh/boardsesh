#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE_REFERENCE="${1:-}"
EXPECTED_PLATFORM="${2:-}"
[[ -n "$IMAGE_REFERENCE" && -n "$EXPECTED_PLATFORM" ]] || {
  printf 'usage: %s <image-reference> <linux/amd64|linux/arm64>\n' "$0" >&2
  exit 1
}
[[ "$EXPECTED_PLATFORM" == 'linux/amd64' || "$EXPECTED_PLATFORM" == 'linux/arm64' ]] || {
  printf 'unsupported smoke platform: %s\n' "$EXPECTED_PLATFORM" >&2
  exit 1
}

readonly CONTAINER_NAME="boardsesh-postgres18-arch-${GITHUB_RUN_ID:-local}-${$}"
readonly VOLUME_NAME="boardsesh-postgres18-arch-${GITHUB_RUN_ID:-local}-${$}"
readonly EXPECTED_POSTGRES_VERSION='18.6'
readonly EXPECTED_POSTGIS_VERSION='3.6.4'
readonly EXPECTED_HYPOPG_VERSION='1.4.3'
readonly EXPECTED_BASE_DIGEST='sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af'

cleanup() {
  docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

image_contract="$(docker image inspect --format \
  '{{ index .Config.Labels "org.boardsesh.postgresql.version" }}|{{ index .Config.Labels "org.boardsesh.postgis.version" }}|{{ index .Config.Labels "org.boardsesh.postgresql.base-digest" }}' \
  "$IMAGE_REFERENCE")"
expected_image_contract="${EXPECTED_POSTGRES_VERSION}|${EXPECTED_POSTGIS_VERSION}|${EXPECTED_BASE_DIGEST}"
[[ "$image_contract" == "$expected_image_contract" ]] || {
  printf 'image version labels differ: got %s; expected %s\n' \
    "$image_contract" "$expected_image_contract" >&2
  exit 1
}

docker volume create "$VOLUME_NAME" >/dev/null
docker run --detach \
  --platform "$EXPECTED_PLATFORM" \
  --name "$CONTAINER_NAME" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=main \
  --volume "$VOLUME_NAME:/var/lib/postgresql" \
  "$IMAGE_REFERENCE" >/dev/null

attempt=0
while [[ "$attempt" -lt 120 ]]; do
  if docker exec --env PGPASSWORD=postgres "$CONTAINER_NAME" \
    psql -X -Atq -h 127.0.0.1 -U postgres -d main -c 'SELECT 1;' >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [[ "$attempt" -eq 120 ]]; then
  docker logs "$CONTAINER_NAME" >&2 || true
  printf 'PostgreSQL did not become ready for %s\n' "$EXPECTED_PLATFORM" >&2
  exit 1
fi

expected_machine='x86_64'
[[ "$EXPECTED_PLATFORM" == 'linux/arm64' ]] && expected_machine='aarch64'
actual_machine="$(docker exec "$CONTAINER_NAME" uname -m)"
[[ "$actual_machine" == "$expected_machine" ]] || {
  printf 'image ran as %s; expected %s for %s\n' "$actual_machine" "$expected_machine" "$EXPECTED_PLATFORM" >&2
  exit 1
}

[[ "$(docker exec "$CONTAINER_NAME" printenv PGDATA)" == '/var/lib/postgresql/18/docker' ]] || {
  printf 'image has an unexpected PGDATA layout\n' >&2
  exit 1
}

docker exec -i "$CONTAINER_NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d main \
  -v expected_postgis_version="$EXPECTED_POSTGIS_VERSION" \
  -v expected_hypopg_version="$EXPECTED_HYPOPG_VERSION" <<'SQL'
SELECT set_config('boardsesh.expected_postgis_version', :'expected_postgis_version', false);
SELECT set_config('boardsesh.expected_hypopg_version', :'expected_hypopg_version', false);
DO $$
BEGIN
  IF current_setting('server_version_num')::integer <> 180006 THEN
    RAISE EXCEPTION 'expected PostgreSQL 18.6, got %', current_setting('server_version');
  END IF;
  IF current_setting('data_checksums') <> 'on' THEN
    RAISE EXCEPTION 'expected data_checksums=on';
  END IF;
END
$$;
CREATE EXTENSION postgis;
CREATE EXTENSION hypopg;
DO $$
BEGIN
  IF postgis_lib_version() <> current_setting('boardsesh.expected_postgis_version') THEN
    RAISE EXCEPTION 'expected PostGIS %, got %',
      current_setting('boardsesh.expected_postgis_version'), postgis_lib_version();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension
    WHERE extname = 'hypopg'
      AND extversion = current_setting('boardsesh.expected_hypopg_version')
  ) THEN
    RAISE EXCEPTION 'expected installed HypoPG %',
      current_setting('boardsesh.expected_hypopg_version');
  END IF;
END
$$;
SQL

printf 'PostgreSQL 18.6 booted with PostGIS 3.6.4 and HypoPG 1.4.3 on %s.\n' \
  "$EXPECTED_PLATFORM"
