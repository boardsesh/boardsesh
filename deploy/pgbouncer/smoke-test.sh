#!/bin/sh
set -eu

pgbouncer_image=${1:-boardsesh-pgbouncer:validation}
postgres_image='docker.io/library/postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0'
resource_suffix="${GITHUB_RUN_ID:-local}-$$"
network_name="pgbouncer-smoke-$resource_suffix"
tls_volume_name="pgbouncer-smoke-tls-$resource_suffix"
postgres_container="pgbouncer-smoke-postgres-$resource_suffix"
pgbouncer_container="pgbouncer-smoke-pool-$resource_suffix"

cleanup() {
  docker rm --force "$pgbouncer_container" "$postgres_container" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  docker volume rm "$tls_volume_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker network create "$network_name" >/dev/null
docker volume create "$tls_volume_name" >/dev/null

docker run --rm \
  --user 0:0 \
  --volume "$tls_volume_name:/tls" \
  --entrypoint sh \
  "$pgbouncer_image" \
  -c 'chown 999:999 /tls'

docker run --rm \
  --user 999:999 \
  --volume "$tls_volume_name:/tls" \
  --entrypoint sh \
  "$pgbouncer_image" \
  -c "openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 -subj '/CN=smoke-ca' -keyout /tls/ca.key -out /tls/ca.crt >/dev/null 2>&1 &&
    openssl req -newkey rsa:2048 -sha256 -nodes -subj '/CN=postgres-smoke' -keyout /tls/server.key -out /tls/server.csr >/dev/null 2>&1 &&
    printf 'subjectAltName=DNS:postgres-smoke\n' >/tls/server.ext &&
    openssl x509 -req -sha256 -days 1 -in /tls/server.csr -CA /tls/ca.crt -CAkey /tls/ca.key -CAcreateserial -extfile /tls/server.ext -out /tls/server.crt >/dev/null 2>&1 &&
    chmod 0600 /tls/server.key"

docker run --detach \
  --name "$postgres_container" \
  --network "$network_name" \
  --network-alias postgres-smoke \
  --env POSTGRES_DB=boardsesh \
  --env POSTGRES_USER=server_user \
  --env POSTGRES_PASSWORD=server_password \
  --env POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
  --volume "$tls_volume_name:/tls:ro" \
  "$postgres_image" \
  -c ssl=on \
  -c ssl_cert_file=/tls/server.crt \
  -c ssl_key_file=/tls/server.key \
  -c password_encryption=scram-sha-256 \
  >/dev/null

postgres_ready=false
for readiness_attempt in $(seq 1 30); do
  if docker exec "$postgres_container" pg_isready --quiet --username=server_user --dbname=boardsesh; then
    postgres_ready=true
    break
  fi
  sleep 1
done
[ "$postgres_ready" = true ] || {
  docker logs "$postgres_container" >&2
  exit 1
}

server_ca="$(docker run --rm --volume "$tls_volume_name:/tls:ro" --entrypoint cat "$pgbouncer_image" /tls/ca.crt)"
export server_ca

docker run --detach \
  --name "$pgbouncer_container" \
  --network "$network_name" \
  --env PGBOUNCER_UPSTREAM_HOST=postgres-smoke \
  --env PGBOUNCER_DATABASE_NAME=boardsesh \
  --env PGBOUNCER_UPSTREAM_USER=server_user \
  --env PGBOUNCER_UPSTREAM_PASSWORD=server_password \
  --env PGBOUNCER_CLIENT_USER=client_user \
  --env PGBOUNCER_CLIENT_PASSWORD=client_password \
  --env PGBOUNCER_CLIENT_USER_NEXT=next_client_user \
  --env PGBOUNCER_CLIENT_PASSWORD_NEXT=next_client_password \
  --env PGBOUNCER_ADMIN_USER=admin_user \
  --env PGBOUNCER_ADMIN_PASSWORD=admin_password \
  --env PGBOUNCER_SERVER_TLS_CA="$server_ca" \
  "$pgbouncer_image" \
  >/dev/null

pgbouncer_healthy=false
for health_attempt in $(seq 1 30); do
  health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$pgbouncer_container")"
  if [ "$health_status" = healthy ]; then
    pgbouncer_healthy=true
    break
  fi
  [ "$health_status" != unhealthy ] || break
  sleep 1
done
[ "$pgbouncer_healthy" = true ] || {
  docker logs "$pgbouncer_container" >&2
  exit 1
}

PGPASSWORD=next_client_password docker exec \
  --env PGPASSWORD \
  --env PGSSLMODE=require \
  "$pgbouncer_container" \
  psql --no-password --no-psqlrc --quiet --host=127.0.0.1 --port=6432 --username=next_client_user --dbname=boardsesh --command='SELECT 1' \
  >/dev/null

if PGPASSWORD=admin_password docker exec \
  --env PGPASSWORD \
  --env PGSSLMODE=require \
  "$pgbouncer_container" \
  psql --no-password --no-psqlrc --quiet --host=127.0.0.1 --port=6432 --username=admin_user --dbname=boardsesh --command='SELECT 1' \
  >/dev/null 2>&1; then
  printf 'admin identity unexpectedly reached the application database\n' >&2
  exit 1
fi

if PGPASSWORD=client_password docker exec \
  --env PGPASSWORD \
  --env PGSSLMODE=require \
  "$pgbouncer_container" \
  psql --no-password --no-psqlrc --quiet --host=127.0.0.1 --port=6432 --username=client_user --dbname=pgbouncer --command='SHOW VERSION' \
  >/dev/null 2>&1; then
  printf 'application identity unexpectedly reached the admin console\n' >&2
  exit 1
fi

printf 'PgBouncer TLS application-path smoke test passed\n'
